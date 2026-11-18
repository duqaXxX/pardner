/**
 * The port of the cleanup of `state.json`: what a chat provider reads to let the owner ask for a
 * pass at once (a refresh control of the chat), beside the ones at start and every six hours.
 */
import type { Cleanups } from "../cleanup.ts";

export type CleanupPage = Pick<Cleanups, "request">;
