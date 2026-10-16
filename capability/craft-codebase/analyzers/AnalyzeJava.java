package craft.codebase;

import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.IdentifierTree;
import com.sun.source.tree.ImportTree;
import com.sun.source.tree.MemberSelectTree;
import com.sun.source.tree.MethodInvocationTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.NewClassTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.VariableTree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.TreePath;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.Trees;
import javax.lang.model.element.Element;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.TypeElement;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;
import java.io.File;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Parses only files staged from a digest-pinned Craft checkpoint. */
public final class AnalyzeJava {
    private static final int MAX_FILES = 2000;
    private static final int MAX_NODES = 60000;
    private static final int MAX_EDGES = 150000;

    private static final class Unit {
        final String path;
        final String source;
        final String digest;
        final CompilationUnitTree tree;
        final String packageName;
        int unresolvedCalls, unresolvedImports;
        String fileId;

        Unit(String path, String source, String digest, CompilationUnitTree tree) {
            this.path = path; this.source = source; this.digest = digest; this.tree = tree;
            this.packageName = tree.getPackageName() == null ? "" : tree.getPackageName().toString();
        }
    }

    private static final class Node {
        final String id, kind, path, name, language, digest, declarationKind;
        final long start, end, declarationStart, declarationEnd;

        Node(String id, String kind, String path, String name, String digest, String declarationKind,
             long start, long end, long declarationStart, long declarationEnd) {
            this.id = id; this.kind = kind; this.path = path; this.name = name; this.language = "java";
            this.digest = digest; this.declarationKind = declarationKind; this.start = start; this.end = end;
            this.declarationStart = declarationStart; this.declarationEnd = declarationEnd;
        }
    }

    private static final class Edge {
        final String kind, from, to;
        final long start, end;
        Edge(String kind, String from, String to, long start, long end) {
            this.kind = kind; this.from = from; this.to = to; this.start = start; this.end = end;
        }
    }

    private final Path root;
    private final Trees trees;
    private final List<Unit> units;
    private final Map<String, Unit> byPath = new HashMap<String, Unit>();
    private final List<Node> nodes = new ArrayList<Node>();
    private final List<Edge> edges = new ArrayList<Edge>();
    private final Map<Element, String> symbolIds = new HashMap<Element, String>();
    private final Map<String, Node> nodesById = new HashMap<String, Node>();
    private final Map<String, Integer> compilerErrorsByPath;
    private final Map<String, Integer> syntaxErrorsByPath;
    private final Set<String> edgeKeys = new HashSet<String>();
    private final Set<String> selectedPaths;
    private int syntaxErrors, compilerErrors, unmappedCompilerErrors, omittedNodes, omittedEdges;

    private AnalyzeJava(Path root, Trees trees, List<Unit> units, Set<String> selectedPaths,
                        Map<String, Integer> compilerErrorsByPath, Map<String, Integer> syntaxErrorsByPath, int unmappedCompilerErrors) {
        this.root = root; this.trees = trees; this.units = units; this.selectedPaths = selectedPaths;
        this.compilerErrorsByPath = compilerErrorsByPath; this.syntaxErrorsByPath = syntaxErrorsByPath;
        this.unmappedCompilerErrors = unmappedCompilerErrors;
        for (Unit unit : units) byPath.put(unit.path, unit);
    }

    public static void main(String[] args) {
        try {
            if (args.length != 1) throw new IllegalArgumentException("snapshot_directory_required");
            Path root = new File(args[0]).toPath().toRealPath();
            Set<String> requestedPaths = readRequestedPaths();
            JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
            if (compiler == null) throw new IllegalStateException("jdk_compiler_unavailable");
            DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<JavaFileObject>();
            try (StandardJavaFileManager manager = compiler.getStandardFileManager(diagnostics, null, StandardCharsets.UTF_8)) {
                List<Path> sourcePaths = new ArrayList<Path>();
                try (java.util.stream.Stream<Path> stream = Files.walk(root)) {
                    stream.filter(path -> Files.isRegularFile(path) && path.getFileName().toString().endsWith(".java"))
                        .forEach(sourcePaths::add);
                }
                Collections.sort(sourcePaths, Comparator.comparing(path -> root.relativize(path).toString()));
                if (sourcePaths.isEmpty() || sourcePaths.size() > MAX_FILES) throw new IllegalArgumentException("java_file_budget_exceeded");
                Set<String> availablePaths = new HashSet<String>();
                for (Path sourcePath : sourcePaths) availablePaths.add(root.relativize(sourcePath).toString().replace(File.separatorChar, '/'));
                if (!availablePaths.containsAll(requestedPaths)) throw new IllegalArgumentException("requested_java_path_missing");
                if (requestedPaths.isEmpty()) requestedPaths.addAll(availablePaths);
                Iterable<? extends JavaFileObject> sourceObjects = manager.getJavaFileObjectsFromFiles(toFiles(sourcePaths));
                List<String> options = new ArrayList<String>();
                options.add("-proc:none"); options.add("-encoding"); options.add("UTF-8");
                options.add("-sourcepath"); options.add(root.toString());
                JavacTask task = (JavacTask) compiler.getTask(null, manager, diagnostics, options, null, sourceObjects);
                List<CompilationUnitTree> trees = new ArrayList<CompilationUnitTree>();
                for (CompilationUnitTree tree : task.parse()) trees.add(tree);
                try { task.analyze(); } catch (RuntimeException ignored) { /* Diagnostics below keep partial evidence explicit. */ }
                Trees sourceTrees = Trees.instance(task);
                List<Unit> units = new ArrayList<Unit>();
                for (int i = 0; i < trees.size(); i++) {
                    CompilationUnitTree tree = trees.get(i);
                    Path sourcePath = sourcePaths.get(i);
                    String path = root.relativize(sourcePath).toString().replace(File.separatorChar, '/');
                    String source = new String(Files.readAllBytes(sourcePath), StandardCharsets.UTF_8);
                    units.add(new Unit(path, source, digest(source), tree));
                }
                Map<String, Integer> compilerErrorsByPath = new HashMap<String, Integer>();
                Map<String, Integer> syntaxErrorsByPath = new HashMap<String, Integer>();
                int compilerErrors = 0, syntaxErrors = 0, unmappedCompilerErrors = 0;
                for (Diagnostic<? extends JavaFileObject> diagnostic : diagnostics.getDiagnostics()) {
                    if (diagnostic.getKind() != Diagnostic.Kind.ERROR) continue;
                    compilerErrors++;
                    String path = snapshotPath(root, diagnostic.getSource());
                    if (path == null || !availablePaths.contains(path)) unmappedCompilerErrors++;
                    else compilerErrorsByPath.put(path, compilerErrorsByPath.getOrDefault(path, 0) + 1);
                    if (isSyntaxError(diagnostic.getCode())) {
                        syntaxErrors++;
                        if (path != null && availablePaths.contains(path)) syntaxErrorsByPath.put(path, syntaxErrorsByPath.getOrDefault(path, 0) + 1);
                    }
                }
                AnalyzeJava analyzer = new AnalyzeJava(root, sourceTrees, units, requestedPaths, compilerErrorsByPath, syntaxErrorsByPath, unmappedCompilerErrors);
                analyzer.compilerErrors = compilerErrors;
                analyzer.syntaxErrors = syntaxErrors;
                analyzer.analyze();
                System.out.println(analyzer.json());
            }
        } catch (Throwable error) {
            String message = error.getMessage();
            System.out.println("{\"format\":\"craft-static-analysis-v1\",\"analyzer\":\"jdk-compiler-tree\",\"analyzer_version\":\"craft-java-javac-v1\",\"nodes\":[],\"edges\":[],\"diagnostics\":{\"status\":\"failed\",\"reason\":" + quote(message == null ? "analysis_failed" : message) + "}}");
        }
    }

    /** The request is a single URL-safe Base64 line so legal newlines in Git paths stay unambiguous. */
    private static Set<String> readRequestedPaths() throws IOException {
        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String encoded = reader.readLine();
        if (encoded == null || "*".equals(encoded)) return new HashSet<String>();
        String decoded = new String(Base64.getUrlDecoder().decode(encoded), StandardCharsets.UTF_8);
        Set<String> paths = new HashSet<String>();
        int start = 0;
        while (start < decoded.length()) {
            int boundary = decoded.indexOf((char) 0, start);
            if (boundary < 0) { paths.add(decoded.substring(start)); break; }
            paths.add(decoded.substring(start, boundary));
            start = boundary + 1;
        }
        return paths;
    }

    private static List<File> toFiles(List<Path> paths) {
        List<File> files = new ArrayList<File>();
        for (Path path : paths) files.add(path.toFile());
        return files;
    }

    private static String snapshotPath(Path root, JavaFileObject source) {
        if (source == null) return null;
        try {
            Path normalizedRoot = root.toAbsolutePath().normalize();
            Path normalizedSource = Paths.get(source.toUri()).toAbsolutePath().normalize();
            if (!normalizedSource.startsWith(normalizedRoot)) return null;
            return normalizedRoot.relativize(normalizedSource).toString().replace(File.separatorChar, '/');
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    private void analyze() {
        for (Unit unit : units) {
            unit.fileId = id(unit.path, "file", unit.path, 0);
            addNode(new Node(unit.fileId, "file", unit.path, unit.path, unit.digest, "", 0, 0, 0, 0));
        }
        for (Unit unit : units) new Declarations(unit).scan(unit.tree, null);
        for (Unit unit : units) if (selectedPaths.contains(unit.path)) new Relations(unit).scan(unit.tree, null);
    }

    private final class Declarations extends TreePathScanner<Void, String> {
        private final Unit unit;
        private String ownerId;
        private String className;
        Declarations(Unit unit) { this.unit = unit; }

        @Override public Void visitClass(ClassTree tree, String ignored) {
            String name = tree.getSimpleName().toString();
            Node node = declaration(tree, name, tree.getKind().name().toLowerCase(), "symbol");
            String previousOwner = ownerId, previousName = className;
            if (node != null) { ownerId = node.id; className = name; bind(tree, node); }
            Void result = super.visitClass(tree, ignored);
            ownerId = previousOwner; className = previousName;
            return result;
        }

        @Override public Void visitMethod(MethodTree tree, String ignored) {
            String rawName = tree.getName().toString();
            String name = "<init>".equals(rawName) ? (className == null ? "<init>" : className) : rawName;
            Node node = declaration(tree, name, "<init>".equals(rawName) ? "constructor" : "method", "symbol");
            String previousOwner = ownerId;
            if (node != null) { ownerId = node.id; bind(tree, node); }
            Void result = super.visitMethod(tree, ignored);
            ownerId = previousOwner;
            return result;
        }

        @Override public Void visitVariable(VariableTree tree, String ignored) {
            TreePath parent = getCurrentPath().getParentPath();
            if (parent != null && parent.getLeaf() instanceof ClassTree) {
                Node node = declaration(tree, tree.getName().toString(), "field", "symbol");
                if (node != null) bind(tree, node);
            }
            return super.visitVariable(tree, ignored);
        }

        private Node declaration(Tree tree, String name, String kind, String nodeKind) {
            long start = trees.getSourcePositions().getStartPosition(unit.tree, tree);
            long end = trees.getSourcePositions().getEndPosition(unit.tree, tree);
            if (start < 0 || end < start) return null;
            if (name.isEmpty()) {
                Node node = new Node(id(unit.path, kind, "<anonymous>", start), nodeKind, unit.path, "<anonymous>", unit.digest, kind,
                    start, start, start, end);
                if (addNode(node)) return node;
                return null;
            }
            long nameStart = nameOffset(unit.source, start, end, name);
            Node node = new Node(id(unit.path, kind, name, nameStart), nodeKind, unit.path, name, unit.digest, kind,
                nameStart, nameStart + name.length(), start, end);
            if (addNode(node)) return node;
            return null;
        }

        private void bind(Tree tree, Node node) {
            Element element = trees.getElement(getCurrentPath());
            if (element != null) symbolIds.put(element, node.id);
        }
    }

    private final class Relations extends TreePathScanner<Void, String> {
        private final Unit unit;
        private String ownerId;
        private String classId;
        Relations(Unit unit) { this.unit = unit; ownerId = unit.fileId; }

        @Override public Void visitClass(ClassTree tree, String ignored) {
            String name = tree.getSimpleName().toString();
            String priorOwner = ownerId, priorClass = classId;
            Element element = trees.getElement(getCurrentPath());
            classId = element == null ? null : symbolIds.get(element);
            if (classId != null) ownerId = classId;
            for (Tree parent : tree.getExtendsClause() == null ? Collections.<Tree>emptyList() : Collections.singletonList(tree.getExtendsClause()))
                addTypeRelation("extends", parent);
            for (Tree parent : tree.getImplementsClause()) addTypeRelation("implements", parent);
            Void result = super.visitClass(tree, ignored);
            ownerId = priorOwner; classId = priorClass;
            return result;
        }

        @Override public Void visitMethod(MethodTree tree, String ignored) {
            String priorOwner = ownerId;
            Element element = trees.getElement(getCurrentPath());
            String methodId = element == null ? null : symbolIds.get(element);
            if (methodId != null) ownerId = methodId;
            if (tree.getReturnType() != null) addTypeRelation("type_definition", tree.getReturnType());
            Void result = super.visitMethod(tree, ignored);
            ownerId = priorOwner;
            return result;
        }

        @Override public Void visitVariable(VariableTree tree, String ignored) {
            if (tree.getType() != null) addTypeRelation("type_definition", tree.getType());
            return super.visitVariable(tree, ignored);
        }

        @Override public Void visitImport(ImportTree tree, String ignored) {
            Element element = trees.getElement(new TreePath(getCurrentPath(), tree.getQualifiedIdentifier()));
            String targetId = element == null ? null : symbolIds.get(element);
            if (targetId != null) addEdge("imports", unit.fileId, targetId, start(tree), end(tree));
            else if (element == null) unit.unresolvedImports++;
            return super.visitImport(tree, ignored);
        }

        @Override public Void visitMethodInvocation(MethodInvocationTree tree, String ignored) {
            addCall(getCurrentPath(), tree);
            return super.visitMethodInvocation(tree, ignored);
        }

        @Override public Void visitNewClass(NewClassTree tree, String ignored) {
            addCall(getCurrentPath(), tree);
            return super.visitNewClass(tree, ignored);
        }

        @Override public Void visitIdentifier(IdentifierTree tree, String ignored) {
            addReference(getCurrentPath(), tree);
            return super.visitIdentifier(tree, ignored);
        }

        @Override public Void visitMemberSelect(MemberSelectTree tree, String ignored) {
            addReference(getCurrentPath(), tree);
            return super.visitMemberSelect(tree, ignored);
        }

        private void addCall(TreePath path, Tree tree) {
            Element element = trees.getElement(path);
            String targetId = element == null ? null : symbolIds.get(element);
            if (targetId != null) addEdge("calls", ownerId, targetId, start(tree), end(tree));
            else if (element == null) unit.unresolvedCalls++;
        }

        private void addReference(TreePath path, Tree tree) {
            Element element = trees.getElement(path);
            String targetId = element == null ? null : symbolIds.get(element);
            if (targetId == null) return;
            addEdge("references", ownerId, targetId, start(tree), end(tree));
            if (element instanceof TypeElement) addEdge("type_definition", ownerId, targetId, start(tree), end(tree));
        }

        private void addTypeRelation(String kind, Tree tree) {
            Element element = trees.getElement(new TreePath(getCurrentPath(), tree));
            String targetId = element == null ? null : symbolIds.get(element);
            if (targetId != null && classId != null) addEdge(kind, classId, targetId, start(tree), end(tree));
        }

        private long start(Tree tree) { return trees.getSourcePositions().getStartPosition(unit.tree, tree); }
        private long end(Tree tree) { return trees.getSourcePositions().getEndPosition(unit.tree, tree); }
    }

    private boolean addNode(Node node) {
        if (nodes.size() >= MAX_NODES) { omittedNodes++; return false; }
        if (nodesById.containsKey(node.id)) return false;
        nodes.add(node); nodesById.put(node.id, node); return true;
    }

    private void addEdge(String kind, String from, String to, long start, long end) {
        if (from == null || to == null || start < 0 || end < start) return;
        String key = kind + "\0" + from + "\0" + to + "\0" + start + "\0" + end;
        if (!edgeKeys.add(key)) return;
        if (edges.size() >= MAX_EDGES) { omittedEdges++; return; }
        edges.add(new Edge(kind, from, to, start, end));
    }

    private String json() {
        StringBuilder out = new StringBuilder(1024 + nodes.size() * 100 + edges.size() * 80);
        Map<String, Node> nodeById = new HashMap<String, Node>();
        for (Node node : nodes) nodeById.put(node.id, node);
        out.append("{\"format\":\"craft-static-analysis-v1\",\"analyzer\":\"jdk-compiler-tree\",\"analyzer_version\":\"craft-java-javac-v1\",\"file_units\":[");
        int unitIndex = 0, unresolvedCallCount = 0, unresolvedImportCount = 0;
        for (Unit unit : units) {
            if (!selectedPaths.contains(unit.path)) continue;
            if (unitIndex++ > 0) out.append(',');
            List<Node> unitNodes = new ArrayList<Node>();
            for (Node node : nodes) if (node.path.equals(unit.path)) unitNodes.add(node);
            List<Edge> unitEdges = new ArrayList<Edge>();
            for (Edge edge : edges) {
                Node source = nodeById.get(edge.from);
                if (source != null && source.path.equals(unit.path)) unitEdges.add(edge);
            }
            unresolvedCallCount += unit.unresolvedCalls; unresolvedImportCount += unit.unresolvedImports;
            out.append("{\"path\":").append(quote(unit.path)).append(",\"source_digest\":").append(quote(unit.digest))
                .append(",\"package_name\":").append(quote(unit.packageName)).append(",\"nodes\":[");
            for (int i = 0; i < unitNodes.size(); i++) { if (i > 0) out.append(','); appendNode(out, unitNodes.get(i)); }
            out.append("],\"edges\":[");
            for (int i = 0; i < unitEdges.size(); i++) { if (i > 0) out.append(','); appendEdge(out, unitEdges.get(i)); }
            boolean safe = unmappedCompilerErrors == 0 && compilerErrorsByPath.getOrDefault(unit.path, 0) == 0
                && syntaxErrorsByPath.getOrDefault(unit.path, 0) == 0 && unit.unresolvedCalls == 0 && unit.unresolvedImports == 0
                && omittedNodes == 0 && omittedEdges == 0;
            out.append("],\"unresolved_calls\":").append(unit.unresolvedCalls).append(",\"unresolved_imports\":")
                .append(unit.unresolvedImports).append(",\"incremental_safe\":").append(safe).append(",\"budget_limited\":false}");
        }
        out.append("],\"diagnostics\":{\"backend\":\"jdk-compiler-tree\",\"external_resolution\":false,\"syntax_errors\":")
            .append(syntaxErrors).append(",\"compiler_errors\":").append(compilerErrors).append(",\"unresolved_calls\":")
            .append(unresolvedCallCount).append(",\"unresolved_imports\":").append(unresolvedImportCount)
            .append(",\"unmapped_compiler_errors\":").append(unmappedCompilerErrors)
            .append(",\"omitted_nodes\":").append(omittedNodes).append(",\"omitted_edges\":").append(omittedEdges)
            .append(",\"budget_limited\":").append(omittedNodes > 0 || omittedEdges > 0).append(",\"selected_file_count\":").append(unitIndex)
            .append(",\"compiler_input_file_count\":").append(units.size()).append("}}");
        return out.toString();
    }

    private static void appendNode(StringBuilder out, Node node) {
        out.append("{\"id\":").append(quote(node.id)).append(",\"kind\":").append(quote(node.kind))
            .append(",\"path\":").append(quote(node.path)).append(",\"name\":").append(quote(node.name))
            .append(",\"language\":\"java\",\"source_digest\":").append(quote(node.digest))
            .append(",\"span\":{\"start_offset\":").append(node.start).append(",\"end_offset\":").append(node.end).append('}');
        if ("symbol".equals(node.kind)) out.append(",\"declaration_kind\":").append(quote(node.declarationKind))
            .append(",\"declaration_span\":{\"start_offset\":").append(node.declarationStart).append(",\"end_offset\":").append(node.declarationEnd).append('}');
        out.append('}');
    }

    private static void appendEdge(StringBuilder out, Edge edge) {
        out.append("{\"kind\":").append(quote(edge.kind)).append(",\"from_node_id\":").append(quote(edge.from))
            .append(",\"to_node_id\":").append(quote(edge.to)).append(",\"source_span\":{\"start_offset\":")
            .append(edge.start).append(",\"end_offset\":").append(edge.end).append("}}");
    }

    private static String id(String path, String kind, String name, long offset) {
        return "java_" + digest(path + "\0" + kind + "\0" + name + "\0" + offset).substring(0, 24);
    }

    private static String digest(String value) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder out = new StringBuilder(bytes.length * 2);
            for (byte item : bytes) out.append(String.format("%02x", item & 0xff));
            return out.toString();
        } catch (Exception error) { throw new IllegalStateException("digest_unavailable"); }
    }

    private static boolean isSyntaxError(String code) {
        return code != null && code.matches("compiler\\.err\\.(expected|illegal\\.start.*|premature\\.eof|not\\.stmt|class\\.expected|unclosed.*|else\\.without\\.if|catch\\.without\\.try|try\\.without\\.catch.*)");
    }

    private static long nameOffset(String source, long start, long end, String name) {
        if (name.isEmpty() || start < 0 || end < start || end > source.length()) return Math.max(0, start);
        int offset = source.indexOf(name, (int) start);
        return offset >= 0 && offset + name.length() <= end ? offset : start;
    }

    private static String quote(String value) {
        if (value == null) return "null";
        StringBuilder out = new StringBuilder(value.length() + 2).append('"');
        for (int i = 0; i < value.length(); i++) {
            char ch = value.charAt(i);
            if (ch == '"' || ch == '\\') out.append('\\').append(ch);
            else if (ch == '\n') out.append("\\n");
            else if (ch == '\r') out.append("\\r");
            else if (ch == '\t') out.append("\\t");
            else if (ch < 0x20) out.append(String.format("\\u%04x", (int) ch));
            else out.append(ch);
        }
        return out.append('"').toString();
    }
}
