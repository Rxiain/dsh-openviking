/**
 * Browser half of dsh-openviking: the OpenViking card inside the dsh web
 * UI's Plugins → Plugin configuration section.
 *
 * The card binds the host-side `openviking` settings namespace through the
 * client settings scope, stages user edits, and writes them with
 * `settings.mutate` path ops (one save = one revision-fenced write). Fields
 * the profile's composition layer owns show an "Overridden" badge and a
 * reset control that clears the user-layer entry; number fields validate
 * before a save is offered. The card is registered into the
 * `settings.plugin.item` keyed slot declared by
 * `@deepseek-ai/dsh-client-ui-settings-plugins` (key = the `openviking`
 * settings namespace), so it appears wherever that section ships — no change
 * to the harness bundle is required beyond the host-side namespace exposure.
 *
 * The bundle is built by `scripts/build-client.mjs` into the dsh browser
 * loader format (`window.__ModuleLoader__.load`) and served by the host's
 * client-module registry at `/plugins/dsh-openviking/client.js`.
 */
import type { Context as ClientContext } from "@deepseek-ai/cordis";
declare module "@deepseek-ai/dsh-client-ui-slots" {
    interface LocaleNamespaceMap {
        /** Dictionary namespace owned by this card. */
        openviking: OpenVikingDictKey;
    }
}
type OpenVikingDictKey = "cardTitle" | "cardDescription" | "groupConnection" | "groupRepoContext" | "groupAutoRecall" | "groupAutoCommit" | "fieldEndpoint" | "fieldEndpointHint" | "fieldApiKey" | "fieldApiKeyHint" | "fieldAccount" | "fieldAccountHint" | "fieldUser" | "fieldUserHint" | "fieldAgentId" | "fieldAgentIdHint" | "fieldTimeoutMs" | "fieldTimeoutMsHint" | "fieldStateFile" | "fieldStateFileHint" | "fieldRepoEnabled" | "fieldRepoEnabledHint" | "fieldCacheTtlMs" | "fieldCacheTtlMsHint" | "fieldRecallEnabled" | "fieldRecallEnabledHint" | "fieldRecallLimit" | "fieldRecallLimitHint" | "fieldScoreThreshold" | "fieldScoreThresholdHint" | "fieldMaxContentChars" | "fieldMaxContentCharsHint" | "fieldTokenBudget" | "fieldTokenBudgetHint" | "fieldAgentSpaces" | "fieldAgentSpacesHint" | "fieldRefreshSteps" | "fieldRefreshStepsHint" | "fieldStartupMapEveryTurns" | "fieldStartupMapEveryTurnsHint" | "fieldCommitEnabled" | "fieldCommitEnabledHint" | "fieldTurns" | "fieldTurnsHint" | "fieldIntervalMinutes" | "fieldIntervalMinutesHint" | "overridden" | "reset" | "readOnly" | "expand" | "collapse" | "save" | "saving" | "discard" | "unsaved" | "saveFailed" | "invalidNumber";
/** Required services (cordis fiber inject). */
export declare const inject: string[];
/**
 * Mount the OpenViking configuration card.
 * @param ctx - the browser plugin context.
 */
export declare function apply(ctx: ClientContext): void;
export {};
