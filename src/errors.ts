/**
 * Exception hierarchy for Claudeleaf.
 *
 * All errors derive from {@link ClaudeleafError}, so callers can catch the whole family.
 */

import type { TrackedChange } from "./types.js";

export class ClaudeleafError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Required configuration is missing or malformed. */
export class ConfigError extends ClaudeleafError {}

/** Authentication with Overleaf failed or the session is invalid. */
export class AuthError extends ClaudeleafError {}

/** The realtime connection cannot be established or is lost. */
export class ConnectionError extends ClaudeleafError {}

/**
 * A frame could not be sent at all (the socket was down). Distinct from a generic
 * ConnectionError because the server never saw the message, so the operation is safe to
 * retry without risk of duplication.
 */
export class NotTransmittedError extends ConnectionError {}

/** The Overleaf realtime protocol behaved unexpectedly. */
export class ProtocolError extends ClaudeleafError {}

/** A request to Overleaf did not complete in time. */
export class TimeoutError extends ClaudeleafError {}

/** A referenced project cannot be found for the account. */
export class ProjectNotFoundError extends ClaudeleafError {}

/** A referenced document or file does not exist in the project. */
export class DocumentNotFoundError extends ClaudeleafError {}

/** An edit cannot be applied (rejected, bad range, ...). */
export class EditError extends ClaudeleafError {}

/**
 * The local document state has diverged from the server. The SDK resyncs automatically
 * in most cases; this surfaces only when retries are exhausted.
 */
export class EditConflictError extends EditError {}

/**
 * The edit would change text inside or at the edge of a pending tracked change (a review-mode
 * suggestion), which would silently alter or remove that suggestion. Nothing was sent. Ask the
 * suggestion's author to accept or reject it first, or retry with `overwriteTrackedChanges`.
 */
export class TrackedChangeConflictError extends EditError {
  constructor(
    message: string,
    /** The suggestions the edit would have touched. */
    readonly changes: TrackedChange[],
  ) {
    super(message);
  }
}
