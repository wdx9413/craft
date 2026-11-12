import type { CraftService } from "../craft-service.ts";
import { knowledgeLineageImpact } from '@craft/capability-knowledge/knowledge-lineage-impact';

export function installKnowledgeRelationMethods(serviceClass: typeof CraftService): void {
  serviceClass.prototype.relationSave = function (args) { return this.knowledgeRelations.relate(args); };
  serviceClass.prototype.relationRetract = function (args) { return this.knowledgeRelations.retract(args); };
  serviceClass.prototype.relationGet = function (args) { return this.knowledgeRelations.get(args); };
  serviceClass.prototype.relationNeighbors = function (args) { return this.knowledgeRelations.neighbors(args); };
  serviceClass.prototype.relationTraverse = function (args) { return this.knowledgeRelations.traverse(args); };
  serviceClass.prototype.knowledgeLineageImpact = function (args) { return knowledgeLineageImpact(this.store, args); };
}
