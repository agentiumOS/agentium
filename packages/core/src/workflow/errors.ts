/** A strict parallel join rejects before applying any of that join's patches. */
export class WorkflowMergeConflict extends Error {
  readonly code = "workflow_merge_conflict";
  readonly conflictingKeys: readonly string[];

  constructor(
    readonly stepName: string,
    conflictingKeys: readonly string[],
  ) {
    const boundedKeys = [...conflictingKeys].slice(0, 100);
    super(`Workflow parallel step ${stepName} has conflicting writes: ${boundedKeys.join(", ")}`);
    this.name = "WorkflowMergeConflict";
    this.conflictingKeys = Object.freeze(boundedKeys);
  }
}

/** Child cancellation escapes ordinary Workflow failure collection and retries. */
export class WorkflowCancellationError extends Error {
  readonly code = "workflow_cancelled";

  constructor(
    readonly stepName: string,
    message = `Workflow child ${stepName} was cancelled`,
  ) {
    super(message);
    this.name = "WorkflowCancellationError";
  }
}

/** A checkpoint cannot be resumed safely under the selected definition. */
export class WorkflowCheckpointError extends Error {
  readonly code = "checkpoint_incompatible";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkflowCheckpointError";
  }
}

/** Invalid generated definitions reject before their episode starts effects. */
export class WorkflowDefinitionError extends Error {
  readonly code = "workflow_definition_invalid";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkflowDefinitionError";
  }
}
