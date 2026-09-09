import { analyzeUntrustedContent } from "../src/untrusted-parser.js";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
    try {
        const request = JSON.parse(input);
        if (typeof request.raw_content !== "string")
            throw new Error("raw_content must be a string");
        process.stdout.write(JSON.stringify({ ok: true,
            analysis: analyzeUntrustedContent(request.raw_content, request.format, request.selectors) }));
    }
    catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Parser worker failed" }));
        process.exitCode = 1;
    }
});
//# sourceMappingURL=craft-parser-worker.js.map