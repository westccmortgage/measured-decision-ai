/* THE UNIT OF WORK IS NOT "ONE MODEL READING ONE PROJECT."
 *
 * It is:
 *
 *   one bounded assignment → one agent attempt → atomic claims
 *     → evidence anchors → comparison → verification → decision
 *
 * Everything in the kernel is typed against the contracts in this file, and
 * nothing in this file names a domain. A source is anything with a content
 * identity; a segment is a bounded part of it with a locator; a subject is a
 * string a domain pack chose; a predicate is a string a domain pack chose. A
 * packet is what an agent is handed; an envelope is what it hands back; a role
 * is the work an agent does, never the provider that does it.
 *
 * The vocabularies marked "mirrors migration 058" are the ones the database
 * enumerates. Everything else is text the domain pack validates.
 */
export const PACKET_VERSION = "core-v2.packet.2";
export const ENGINE_VERSION = "core-v2.1";
export const TASK_PHASES = ["ingest", "discover", "analyze", "compare", "verify", "adjudicate", "derive", "compose"];
/* The kernel's own task types. A domain pack's are namespaced `<pack>:<name>`
   and belong to the analyze, discover or derive phase. */
export const KERNEL_TASK_TYPES = {
    ingest: "ingest_source",
    discover: "discover_segments",
    compare: "compare_claims",
    verifyClaim: "verify_claim",
    verifyDisagreement: "verify_disagreement",
    adjudicate: "adjudicate",
    compose: "compose_decision",
};
export const ACTIVE_WORKFLOW_STATES = ["created", "queued", "planning", "running", "needs_attention", "ready_for_decision", "deciding"];
export const AGENT_ACTION_TYPES = [
    "open_linked_segment", "expand_segment", "read_related_segment", "read_reference_segment", "check_unit",
    "request_independent_reader", "request_evidence_critic", "request_disagreement_verification",
    "request_human_review",
];
