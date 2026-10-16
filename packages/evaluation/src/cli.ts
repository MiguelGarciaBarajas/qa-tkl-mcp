import { runEvaluation } from "./harness.ts";

/**
 * Command-line entry point: runs the golden dataset through the real pipeline and
 * prints the resulting `EvaluationMetrics` report as JSON on stdout.
 *
 * Usage: npm run evaluate --workspace=@tkl/evaluation
 * Usage (save a report, not committed - see .gitignore): npm run evaluate --workspace=@tkl/evaluation > report.json
 *
 * Owner: Clemente Herrera (Dashboard and Evaluation).
 */
const report = await runEvaluation();
console.log(JSON.stringify(report, null, 2));
