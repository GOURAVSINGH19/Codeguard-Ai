/**
 * Minimal pipeline runner: sequential steps, parallel groups (fan-out /
 * fan-in), per-node timing, and two failure modes:
 *  - required step fails → the run fails (the caller marks the review failed)
 *  - optional step fails → recorded in the trace, the run continues with
 *    whatever that step would have produced left at its default
 */

export interface PipelineStep<S> {
  name: string;
  run: (state: S) => Promise<void>;
  /** Failure is recorded and the pipeline continues. */
  optional?: boolean;
}

export interface PipelineGroup<S> {
  name: string;
  parallel: PipelineStep<S>[];
  /** Fan-in: runs after every parallel step has finished. */
  join?: PipelineStep<S>;
}

export type PipelineNode<S> = PipelineStep<S> | PipelineGroup<S>;

export interface NodeTrace {
  name: string;
  group?: string;
  status: "ok" | "failed" | "skipped";
  durationMs: number;
  error?: string;
}

export interface PipelineHooks {
  onNodeStart?: (name: string) => void | Promise<void>;
  onNodeEnd?: (trace: NodeTrace) => void | Promise<void>;
  /** Checked before each node; a reason string ends the run early (remaining nodes are "skipped"). */
  stopReason?: () => string | null;
}

export class PipelineError extends Error {
  constructor(readonly node: string, readonly cause: unknown, readonly trace: NodeTrace[]) {
    super(`pipeline node "${node}" failed: ${(cause as Error)?.message ?? String(cause)}`);
    this.name = "PipelineError";
  }
}

export interface PipelineResult {
  trace: NodeTrace[];
  stoppedEarly: string | null;
}

export async function runPipeline<S>(nodes: PipelineNode<S>[], state: S, hooks: PipelineHooks = {}): Promise<PipelineResult> {
  const trace: NodeTrace[] = [];
  let stopped: string | null = null;

  const runStep = async (step: PipelineStep<S>, group?: string): Promise<void> => {
    await hooks.onNodeStart?.(step.name);
    const started = Date.now();
    try {
      await step.run(state);
      const t: NodeTrace = { name: step.name, group, status: "ok", durationMs: Date.now() - started };
      trace.push(t);
      await hooks.onNodeEnd?.(t);
    } catch (err) {
      const t: NodeTrace = { name: step.name, group, status: "failed", durationMs: Date.now() - started, error: String((err as Error)?.message ?? err).slice(0, 300) };
      trace.push(t);
      await hooks.onNodeEnd?.(t);
      if (!step.optional) throw new PipelineError(step.name, err, trace);
    }
  };

  for (const node of nodes) {
    stopped = stopped ?? hooks.stopReason?.() ?? null;
    if (stopped) {
      const names = "parallel" in node ? [...node.parallel.map((s) => s.name), ...(node.join ? [node.join.name] : [])] : [node.name];
      for (const name of names) trace.push({ name, status: "skipped", durationMs: 0 });
      continue;
    }
    if ("parallel" in node) {
      // allSettled so a required failure still lets siblings finish and be traced.
      const results = await Promise.allSettled(node.parallel.map((s) => runStep(s, node.name)));
      const failure = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failure) throw failure.reason;
      if (node.join) await runStep(node.join, node.name);
    } else {
      await runStep(node);
    }
  }
  return { trace, stoppedEarly: stopped };
}
