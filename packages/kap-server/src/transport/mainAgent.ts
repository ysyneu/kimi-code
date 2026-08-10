/**
 * server-v2 — on-demand main-agent resolution.
 *
 * Sessions are created without a main agent; the first request that targets
 * `main` materializes it here. Both the `/api/v1` routes and the `/api/v1/debug`
 * dispatcher resolve the main agent through {@link ensureMainAgent} so a
 * missing main agent is created instead of reported as `agent.not_found`.
 *
 * The main agent is created unbound (no Profile / Model). It becomes runnable
 * when the edge binds a Model — via the `profile:setModel` action, a legacy
 * prompt's `body.model` override, or a resumed wire log — at which point the
 * default profile is applied automatically. There is intentionally no default
 * model baked in here: a runnable agent only exists once a model is chosen.
 *
 * `ensureMainAgent` and `MAIN_AGENT_ID` are re-exports of the core
 * `agentLifecycle` domain, so main-agent bootstrap lives in exactly one place;
 * {@link ensureMainAgentBound} extends that "exactly one place" rule to the
 * runnability half of the bootstrap.
 */

import {
  DEFAULT_AGENT_PROFILE_NAME,
  Error2,
  ErrorCodes,
  ProfileError,
  ProfileErrors,
  type IAgentProfileService,
} from '@moonshot-ai/agent-core-v2';

export { ensureMainAgent, MAIN_AGENT_ID } from '@moonshot-ai/agent-core-v2';

/**
 * Make an agent runnable before a route starts a turn on it.
 *
 * A session created over REST carries no model selection, so its main agent is
 * still unbound whenever the request that starts the turn named neither
 * `profile` nor `model`. Binding happens here, at turn-start time rather than
 * at agent creation, because bind is first-bind-only: an eager bind would
 * reject the legitimate "create model-less, bind a custom `profile` on the
 * first prompt" flow. Once bound to the default profile the engine falls back
 * to the configured `default_model`, so the turn no longer dies with
 * `model.not_configured`.
 *
 * Every route that starts a turn must call this — prompt submission and skill
 * activation both do. Keeping it in one function is the point: while the bind
 * lived inline in the prompt route only, skill activation started turns on
 * unbound agents and every one of them failed.
 *
 * An already-bound agent is a no-op. A deployment with no model configured at
 * all is also a no-op: binding cannot make the agent runnable, and refusing
 * the request here would only replace the turn's own `model.not_configured`
 * — the very same error code the bind raises — with a less precise one at the
 * transport layer. Every other `ProfileError` (unknown profile name, post-bind
 * switch) is mapped onto `REQUEST_INVALID`, matching how the prompt route has
 * always reported it; anything else propagates.
 */
export async function ensureMainAgentBound(profile: IAgentProfileService): Promise<void> {
  if (profile.data().profileName !== undefined) return;
  try {
    await profile.bind({ profile: DEFAULT_AGENT_PROFILE_NAME });
  } catch (error) {
    if (error instanceof ProfileError) {
      if (error.code === ProfileErrors.codes.MODEL_NOT_CONFIGURED) return;
      throw new Error2(ErrorCodes.REQUEST_INVALID, error.message);
    }
    throw error;
  }
}
