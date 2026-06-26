/**
 * Exception hierarchy for Claudeleaf.
 *
 * All errors derive from {@link ClaudeleafError}, so callers can catch the whole family.
 */

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
