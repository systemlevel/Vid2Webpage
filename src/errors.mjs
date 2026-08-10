export class V2wError extends Error {
  constructor(message, { code = "V2W_ERROR", exitCode = 1, cause } = {}) {
    super(message, { cause });
    this.name = new.target.name;
    this.code = code;
    this.exitCode = exitCode;
  }
}

export class UsageError extends V2wError {
  constructor(message) {
    super(message, { code: "USAGE", exitCode: 2 });
  }
}

export class DependencyError extends V2wError {}
export class SourceError extends V2wError {}
export class TranscriptionError extends V2wError {}
export class TranscriptQualityError extends V2wError {}
export class OutputConflictError extends V2wError {}
