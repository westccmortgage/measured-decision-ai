/* WHO ACTUALLY DOES THE WORK, AND HOW THE KERNEL KNOWS TWO OF THEM APART.
 *
 * An executor is code, a model behind an adapter, or a person behind a form.
 * The registry maps abstract families to executors and assigns every
 * executor instance an independence domain of its own at registration: two
 * families registered against one instance share one domain, and a label in
 * a routing table or an envelope cannot change that. Independence is decided
 * on domains, never on names.
 *
 * Execution takes an AbortSignal. A timed-out attempt is aborted; whether the
 * executor honours that is the executor's business, and until its promise
 * settles the kernel keeps counting it against concurrency.
 */
import { randomBytes } from "../../engine-shims/node-crypto.js";
import { sha256 } from "./ids.js";
export class ExecutorRegistry {
    byFamily = new Map();
    domains = new Map();
    nonce = randomBytes(8).toString("hex");
    invocations = [];
    packetsSeen = [];
    /* One instance, one domain, whatever it is called.
  
       A caller that can name an instance in a way that outlives the process
       passes that name, and the domain is derived from it. That matters at a
       restart: the record says which domain read a subject, and a fresh
       registry that invented new domain ids would call every domain unused and
       let one reader read the same subject twice under two names. A caller
       with nothing durable to say leaves it out and gets a domain unique to
       this registry, which is the honest answer for an executor that exists
       only while this process does. Two different instances may not claim one
       durable name: that would be two opinions wearing one domain. */
    register(executor, families, durableIdentity) {
        let domain = this.domains.get(executor);
        if (!domain) {
            domain = `domain:${sha256(durableIdentity ? `durable-executor:${durableIdentity}` : `${this.nonce}:${this.domains.size}`).slice(0, 12)}`;
            for (const [other, taken] of this.domains) {
                if (taken === domain && other !== executor)
                    throw new Error(`core-v2: two executors claim the durable identity ${durableIdentity}, and one identity is one domain`);
            }
            this.domains.set(executor, domain);
        }
        for (const family of families) {
            if (this.byFamily.has(family) && this.byFamily.get(family) !== executor)
                throw new Error(`core-v2: family ${family} is already served by another executor`);
            this.byFamily.set(family, executor);
        }
        return domain;
    }
    has(family) { return this.byFamily.has(family); }
    families() { return [...this.byFamily.keys()]; }
    resolve(family) {
        const executor = this.byFamily.get(family);
        if (!executor)
            throw new Error(`core-v2: no executor serves family ${family}`);
        return { executor, domain: this.domains.get(executor) };
    }
    domainOf(family) {
        const executor = this.byFamily.get(family);
        return executor ? this.domains.get(executor) : null;
    }
    async run(selection, packet, context) {
        const { executor, domain } = this.resolve(selection.executorFamily);
        if (domain !== selection.independenceDomain)
            throw new Error(`core-v2: family ${selection.executorFamily} is not in domain ${selection.independenceDomain}`);
        this.invocations.push({ family: selection.executorFamily, independenceDomain: domain, taskId: packet.taskId, roleKey: packet.roleKey, attemptId: context.attemptId });
        this.packetsSeen.push(packet);
        return executor.execute(packet, context);
    }
    async reconcile(family, attemptId) {
        const executor = this.byFamily.get(family);
        if (!executor || !executor.reconcile)
            return "unknown";
        return executor.reconcile(attemptId);
    }
}
