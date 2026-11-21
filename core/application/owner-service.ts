import type { CraftService } from "./craft-service.ts";

const routed = new WeakMap<CraftService, CraftService>();

function memberOwner(member: string): string | undefined {
  if (member === "evolutionProgramMemoryExperienceSubmit") return "experience";
  if (/^(?:workbench)?knowledge|^wiki|^projectKnowledge|^projectBrain|^relation/iu.test(member)) return "knowledge";
  if (/^(?:workbench)?memory|^episodic|^semanticMemory/iu.test(member)) return "memory";
  if (/^(?:workbench)?experience|^workflowEvolution|^procedure|^workflowTrial|^workbenchWorkflow|^learningCycle/iu.test(member)) return "experience";
  if (/^codebase/iu.test(member)) return "codebase";
  if (/^craftNotes|^contextNotesResolve/iu.test(member)) return "notes";
  if (/^evaluationContract|^workbenchEvaluation|^evalCampaign|^evalSummary/iu.test(member)) return "eval";
  if (/^evolution|^selfEvolution|^context|^decisionContextGate/iu.test(member)) return "context";
  if (member !== "trace" && /^(?:trace|task|workbench|workspace|workObject|workLaunch|workDelivery|workControl|host|runtime|sandbox|local|execution|artifact|state|pilot|command|source|logical|capability|workflowDag|workflowRun|workflowList|workflowGet)/iu.test(member)) return "runtime";
  return undefined;
}

/** The composed facade delegates whole domain operations; it never shares their commit transaction. */
export function routeOwnedService(service: CraftService): CraftService {
  if (service.capabilityOwned !== true) return service;
  const existing = routed.get(service);
  if (existing) return existing;
  const proxy = new Proxy(service, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof property !== "string" || ["capabilityOwned", "storageOwner", "ownerServices", "store", "constructor"].includes(property)) return value;
      const owner = memberOwner(property);
      const memorySource = target.storageOwner === "memory" && /^(?:knowledgeSources|knowledgeMemoryInstallBuiltins|knowledgeSourceList)$/u.test(property);
      if (!owner || owner === target.storageOwner || memorySource) return typeof value === "function" ? value.bind(target) : value;
      const destination = () => {
        const peer = target.ownerServices.get(owner);
        if (!peer || peer === target) throw new Error(`${owner} owner is unavailable`);
        return peer;
      };
      // Handler catalogs bind all verbs at startup; an optional peer is required only when used.
      if (typeof value === "function") return (...args: unknown[]) => {
        const peer = destination();
        const method = Reflect.get(peer, property) as (...input: unknown[]) => unknown;
        return method.apply(peer, args);
      };
      return Reflect.get(destination(), property);
    },
  });
  routed.set(service, proxy);
  routed.set(proxy, proxy);
  return proxy;
}
