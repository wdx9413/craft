package craft.codebase;

import com.sun.source.tree.BlockTree;
import com.sun.source.tree.BreakTree;
import com.sun.source.tree.ConditionalExpressionTree;
import com.sun.source.tree.ContinueTree;
import com.sun.source.tree.DoWhileLoopTree;
import com.sun.source.tree.EnhancedForLoopTree;
import com.sun.source.tree.ExpressionStatementTree;
import com.sun.source.tree.ForLoopTree;
import com.sun.source.tree.IfTree;
import com.sun.source.tree.LambdaExpressionTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.ReturnTree;
import com.sun.source.tree.StatementTree;
import com.sun.source.tree.SynchronizedTree;
import com.sun.source.tree.SwitchTree;
import com.sun.source.tree.ThrowTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.TryTree;
import com.sun.source.tree.WhileLoopTree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.TreePath;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.Trees;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/** Builds a bounded source-free CFG from one file in a digest-pinned Craft snapshot. */
public final class AnalyzeJavaControlFlow {
    private static final int MAX_BLOCKS = 500;
    private static final int MAX_EDGES = 800;
    private static final class Pending { final String from, kind; Pending(String from, String kind) { this.from = from; this.kind = kind; } }
    private static final class Fragment { String entry; final List<Pending> exits = new ArrayList<Pending>(); }
    private static final class Loop { final String continueTo; final List<String> breaks = new ArrayList<String>(); Loop(String target) { continueTo = target; } }
    private static final class Block { final String id, kind; final long start, end; final String syntax; Block(String id, String kind, long start, long end, String syntax) { this.id=id;this.kind=kind;this.start=start;this.end=end;this.syntax=syntax; } }
    private static final class Edge { final String from,to,kind; final boolean back; Edge(String from,String to,String kind,boolean back){this.from=from;this.to=to;this.kind=kind;this.back=back;} }
    private final String source, symbolId, symbolName;
    private final Trees trees;
    private final com.sun.source.tree.CompilationUnitTree unit;
    private final Set<String> unsupported = new LinkedHashSet<String>();
    private final List<Block> blocks = new ArrayList<Block>();
    private final List<Edge> edges = new ArrayList<Edge>();
    private final List<String> returns = new ArrayList<String>(), throwsBlocks = new ArrayList<String>();
    private int parseErrors;
    private AnalyzeJavaControlFlow(String source,String symbolId,String symbolName,Trees trees,com.sun.source.tree.CompilationUnitTree unit,int parseErrors){this.source=source;this.symbolId=symbolId;this.symbolName=symbolName;this.trees=trees;this.unit=unit;this.parseErrors=parseErrors;}

    public static void main(String[] args) {
        try {
            if(args.length!=5) throw new IllegalArgumentException("control_flow_arguments_required");
            Path root=Paths.get(args[0]).toRealPath(), file=root.resolve(args[1]).normalize();
            if(!file.startsWith(root)||!args[1].endsWith(".java")) throw new IllegalArgumentException("unsafe_java_path");
            String source=new String(Files.readAllBytes(file),StandardCharsets.UTF_8);
            JavaCompiler compiler=ToolProvider.getSystemJavaCompiler(); if(compiler==null)throw new IllegalStateException("jdk_compiler_unavailable");
            DiagnosticCollector<JavaFileObject> diagnostics=new DiagnosticCollector<JavaFileObject>();
            try(StandardJavaFileManager manager=compiler.getStandardFileManager(diagnostics,null,StandardCharsets.UTF_8)){
                Iterable<? extends JavaFileObject> sources=manager.getJavaFileObjectsFromFiles(Collections.singletonList(file.toFile()));
                JavacTask task=(JavacTask)compiler.getTask(null,manager,diagnostics,java.util.Arrays.asList("-proc:none","-encoding","UTF-8"),null,sources);
                com.sun.source.tree.CompilationUnitTree unit=task.parse().iterator().next();
                int parseErrors=0;for(Diagnostic<? extends JavaFileObject>d:diagnostics.getDiagnostics())if(d.getKind()==Diagnostic.Kind.ERROR&&isSyntaxError(d.getCode()))parseErrors++;
                AnalyzeJavaControlFlow analyzer=new AnalyzeJavaControlFlow(source,args[2],args[3],Trees.instance(task),unit,parseErrors);
                long offset=Long.parseLong(args[4]);
                final MethodTree[] target=new MethodTree[1];
                new TreePathScanner<Void,Void>(){@Override public Void visitMethod(MethodTree tree,Void ignored){long start=analyzer.start(tree),end=analyzer.end(tree);long nameOffset=analyzer.nameOffset(start,end,args[3]);if(nameOffset==offset)target[0]=tree;return super.visitMethod(tree,ignored);}}.scan(unit,null);
                if(target[0]==null||target[0].getBody()==null)throw new IllegalArgumentException("indexed_java_method_not_found");
                System.out.println(analyzer.build(target[0]));
            }
        }catch(Throwable error){String message=error.getMessage();System.out.println("{\"format\":\"craft-java-control-flow-v1\",\"language\":\"java\",\"status\":\"unavailable\",\"blocks\":[],\"edges\":[],\"partial_reasons\":["+quote(message==null?"analysis_failed":message)+"],\"source_content_included\":false}");}
    }
    private String build(MethodTree method){Block entry=add("entry",null),exit=add("exit",null),exception=add("exception_exit",null);inspect(method.getBody());Fragment body=sequence(method.getBody().getStatements(),null);if(body.entry==null)edge(entry.id,exit.id,"normal",false);else{edge(entry.id,body.entry,"entry",false);connect(body.exits,exit.id,false);}for(String id:returns)edge(id,exit.id,"return",false);for(String id:throwsBlocks)edge(id,exception.id,"exception",false);if(parseErrors>0)unsupported.add("SyntaxErrors");
        StringBuilder out=new StringBuilder("{\"format\":\"craft-java-control-flow-v1\",\"language\":\"java\",\"granularity\":\"statement\",\"symbol_id\":").append(quote(symbolId)).append(",\"blocks\":[");
        for(int i=0;i<blocks.size();i++){if(i>0)out.append(',');Block b=blocks.get(i);out.append("{\"id\":").append(quote(b.id)).append(",\"kind\":").append(quote(b.kind)).append(",\"span\":{\"start_offset\":").append(b.start).append(",\"end_offset\":").append(b.end).append(",\"start_line\":").append(line(b.start)).append(",\"start_column\":").append(column(b.start)).append(",\"end_line\":").append(line(b.end)).append(",\"end_column\":").append(column(b.end)).append('}');if(b.syntax!=null)out.append(",\"syntax_kind\":").append(quote(b.syntax));out.append('}');}
        out.append("],\"edges\":[");for(int i=0;i<edges.size();i++){if(i>0)out.append(',');Edge e=edges.get(i);out.append("{\"from_block_id\":").append(quote(e.from)).append(",\"to_block_id\":").append(quote(e.to)).append(",\"kind\":").append(quote(e.kind));if(e.back)out.append(",\"loop_back\":true");out.append('}');}
        out.append("],\"entry_block_id\":").append(quote(entry.id)).append(",\"exit_block_id\":").append(quote(exit.id)).append(",\"exception_exit_block_id\":").append(quote(exception.id)).append(",\"status\":").append(quote(unsupported.isEmpty()?"complete":"partial")).append(",\"partial_reasons\":[");int i=0;List<String> reasons=new ArrayList<String>(unsupported);Collections.sort(reasons);for(String reason:reasons){if(i++>0)out.append(',');out.append(quote(reason));}return out.append("],\"parse_error_count\":").append(parseErrors).append(",\"source_content_included\":false,\"control_flow_only\":true,\"max_blocks\":").append(MAX_BLOCKS).append(",\"max_edges\":").append(MAX_EDGES).append('}').toString();}
    private Fragment sequence(List<? extends StatementTree> statements,Loop loop){Fragment result=new Fragment();List<Pending> exits=new ArrayList<Pending>();for(StatementTree statement:statements){Fragment next=compile(statement,loop);if(next.entry==null)continue;if(result.entry==null)result.entry=next.entry;connect(exits,next.entry,false);exits=next.exits;}result.exits.addAll(exits);return result;}
    private Fragment atom(Tree tree,String kind){Block b=add(kind,tree);Fragment f=new Fragment();f.entry=b.id;f.exits.add(new Pending(b.id,"normal"));return f;}
    private Fragment compile(StatementTree s,Loop loop){
        if(s instanceof BlockTree)return sequence(((BlockTree)s).getStatements(),loop);
        if(s instanceof IfTree){IfTree t=(IfTree)s;Block c=add("condition",t.getCondition());Fragment yes=compile(t.getThenStatement(),loop);Fragment no=t.getElseStatement()==null?null:compile(t.getElseStatement(),loop);List<Pending>x=new ArrayList<Pending>();if(yes.entry==null)x.add(new Pending(c.id,"true"));else{edge(c.id,yes.entry,"true",false);x.addAll(yes.exits);}if(no==null)x.add(new Pending(c.id,"false"));else if(no.entry==null)x.add(new Pending(c.id,"false"));else{edge(c.id,no.entry,"false",false);x.addAll(no.exits);}Fragment f=new Fragment();f.entry=c.id;f.exits.addAll(x);return f;}
        if(s instanceof WhileLoopTree)return loop((WhileLoopTree)s,loop);
        if(s instanceof DoWhileLoopTree)return loop((DoWhileLoopTree)s,loop);
        if(s instanceof ForLoopTree)return loop((ForLoopTree)s,loop);
        if(s instanceof EnhancedForLoopTree)return loop((EnhancedForLoopTree)s,loop);
        if(s instanceof ReturnTree){Fragment f=atom(s,"return");returns.add(f.entry);f.exits.clear();return f;}
        if(s instanceof ThrowTree){Fragment f=atom(s,"throw");throwsBlocks.add(f.entry);f.exits.clear();return f;}
        if(s instanceof BreakTree){Fragment f=atom(s,"break");BreakTree t=(BreakTree)s;if(t.getLabel()!=null||loop==null)unsupported.add("BreakTree");else loop.breaks.add(f.entry);f.exits.clear();return f;}
        if(s instanceof ContinueTree){Fragment f=atom(s,"continue");ContinueTree t=(ContinueTree)s;if(t.getLabel()!=null||loop==null)unsupported.add("ContinueTree");else edge(f.entry,loop.continueTo,"continue",false);f.exits.clear();return f;}
        if(s instanceof TryTree||s instanceof SwitchTree||s instanceof SynchronizedTree){unsupported.add(s.getKind().name());return atom(s,"unsupported_statement");}
        return atom(s,"statement");
    }
    private Fragment loop(StatementTree statement,Loop parent){Tree condition;StatementTree body;List<? extends StatementTree> init=Collections.emptyList();List<? extends ExpressionStatementTree> update=Collections.emptyList();boolean post=false,hasCondition=true;
        if(statement instanceof WhileLoopTree){WhileLoopTree t=(WhileLoopTree)statement;condition=t.getCondition();body=t.getStatement();}
        else if(statement instanceof DoWhileLoopTree){DoWhileLoopTree t=(DoWhileLoopTree)statement;condition=t.getCondition();body=t.getStatement();post=true;}
        else if(statement instanceof ForLoopTree){ForLoopTree t=(ForLoopTree)statement;condition=t.getCondition()==null?t:t.getCondition();body=t.getStatement();init=t.getInitializer();update=t.getUpdate();hasCondition=t.getCondition()!=null;}
        else{EnhancedForLoopTree t=(EnhancedForLoopTree)statement;condition=t.getExpression();body=t.getStatement();}
        Block c=add("loop_condition",condition);Block updateStart=null;String continueTo=c.id;
        if(!update.isEmpty()){List<Block> updateBlocks=new ArrayList<Block>();for(ExpressionStatementTree u:update)updateBlocks.add(add("loop_update",u));updateStart=updateBlocks.get(0);continueTo=updateStart.id;for(int i=0;i<updateBlocks.size()-1;i++)edge(updateBlocks.get(i).id,updateBlocks.get(i+1).id,"normal",false);edge(updateBlocks.get(updateBlocks.size()-1).id,c.id,"loop_back",true);}
        Loop target=new Loop(continueTo);Fragment b=compile(body,target);String entry=c.id;
        if(post){entry=b.entry==null?c.id:b.entry;if(b.entry==null)edge(c.id,c.id,"true",true);else edge(c.id,b.entry,"true",true);connect(b.exits,continueTo,true);}
        else{if(b.entry==null)edge(c.id,continueTo,"true",updateStart==null);else edge(c.id,b.entry,"true",false);connect(b.exits,continueTo,updateStart==null);}
        if(!init.isEmpty()){Fragment initFlow=sequence(init,parent);if(initFlow.entry!=null){entry=initFlow.entry;connect(initFlow.exits,c.id,false);}}
        Fragment f=new Fragment();f.entry=entry;if(hasCondition)f.exits.add(new Pending(c.id,"false"));for(String id:target.breaks)f.exits.add(new Pending(id,"break"));return f;
    }
    private void inspect(Tree tree){if(tree==null)return;new com.sun.source.util.TreeScanner<Void,Void>(){@Override public Void scan(Tree node,Void ignored){if(node==null)return null;if(node instanceof LambdaExpressionTree){unsupported.add("LambdaExpressionTree");return null;}if(node instanceof ConditionalExpressionTree)unsupported.add("ConditionalExpressionTree");if(node.getKind()==Tree.Kind.CONDITIONAL_AND||node.getKind()==Tree.Kind.CONDITIONAL_OR)unsupported.add("ShortCircuitExpression");return super.scan(node,ignored);}}.scan(tree,null);}
    private Block add(String kind,Tree tree){if(blocks.size()>=MAX_BLOCKS)throw new IllegalArgumentException("control_flow_block_budget_exceeded");long start=tree==null?0:start(tree),end=tree==null?0:end(tree);String id="java_flow_"+digest(symbolId+"\0"+blocks.size()+"\0"+kind+"\0"+start+"\0"+end).substring(0,16);Block b=new Block(id,kind,start,end,tree==null?null:tree.getKind().name());blocks.add(b);return b;}
    private void edge(String from,String to,String kind,boolean back){if(edges.size()>=MAX_EDGES)throw new IllegalArgumentException("control_flow_edge_budget_exceeded");edges.add(new Edge(from,to,kind,back));}
    private void connect(List<Pending> pending,String to,boolean back){for(Pending p:pending)edge(p.from,to,p.kind,back);}
    private long start(Tree t){return trees.getSourcePositions().getStartPosition(unit,t);}private long end(Tree t){return trees.getSourcePositions().getEndPosition(unit,t);}
    private long nameOffset(long start,long end,String name){if(start<0||end<start||end>source.length())return -1;int at=source.indexOf(name,(int)start);return at>=0&&at+name.length()<=end?at:start;}
    private int line(long offset){int result=1;for(int i=0;i<Math.min(offset,source.length());i++)if(source.charAt(i)=='\n')result++;return result;}private int column(long offset){int i=(int)Math.min(offset,source.length())-1;while(i>=0&&source.charAt(i)!='\n')i--;return (int)Math.min(offset,source.length())-i;}
    private static boolean isSyntaxError(String code){return code!=null&&code.matches("compiler\\.err\\.(expected|illegal\\.start.*|premature\\.eof|not\\.stmt|class\\.expected|unclosed.*|else\\.without\\.if|catch\\.without\\.try|try\\.without\\.catch.*)");}
    private static String digest(String value){try{byte[]bytes=MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));StringBuilder out=new StringBuilder();for(byte b:bytes)out.append(String.format("%02x",b&255));return out.toString();}catch(Exception e){throw new IllegalStateException("digest_unavailable");}}
    private static String quote(String value){StringBuilder out=new StringBuilder("\"");for(int i=0;i<value.length();i++){char c=value.charAt(i);if(c=='\"'||c=='\\')out.append('\\').append(c);else if(c=='\n')out.append("\\n");else if(c=='\r')out.append("\\r");else if(c=='\t')out.append("\\t");else if(c<32)out.append(String.format("\\u%04x",(int)c));else out.append(c);}return out.append('\"').toString();}
}
