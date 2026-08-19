import type { ClientsRepo } from './clients-repo.js';
import type { AuditRepo } from './audit-repo.js';
import type { Commands } from './commands.js';
import type { ControlActor, ClientInfo, PrincipalKind, Scope, Sensitivity } from './types.js';
import type { PolicyV1 } from './policy.js';
import { profileFor, type GrantProfile } from './policy.js';
import type { WebPrincipalsRepo } from './web-principals-repo.js';
import type { EnrollmentsRepo } from './enrollments-repo.js';

export interface ControlDeps {
  commands: Commands;
  clientsRepo: ClientsRepo;
  auditRepo: AuditRepo;
  webPrincipalsRepo: WebPrincipalsRepo;
  enrollmentsRepo: EnrollmentsRepo;
  policiesRepo: { getCurrent(namespace: string): { version: number; policy: PolicyV1 } | null; apply(namespace: string, rules: unknown, createdBy: string): { version: number }; history(namespace: string): unknown[] };
}

function assertAdmin(actor: ControlActor): void {
  if (!actor.principal.controlAdmin || actor.principal.disabled) throw new Error('control_admin capability is required');
}

function auditActor(actor: ControlActor): string {
  return `web:${actor.principal.id}`;
}

export function createControlCommands(deps: ControlDeps) {
  function createAgent(actor: ControlActor, input: {
    id: string; name: string; namespace: string; principalKind: PrincipalKind;
    scopes: Scope[]; maxSensitivity?: Sensitivity; readSources?: string[] | null; profile?: GrantProfile;
    authMethod?: ClientInfo['auth_method'];
  }) {
    assertAdmin(actor);
    const created = deps.clientsRepo.create(input);
    deps.auditRepo.log({ namespace: input.namespace, clientId: auditActor(actor), action: 'control.agent.create', outcome: 'allow', details: { target: created.client.id, principal_kind: input.principalKind, profile: input.profile ?? 'none' } });
    if (input.profile && input.profile !== 'none') {
      const current = deps.policiesRepo.getCurrent(input.namespace);
      if (!current) throw new Error(`namespace "${input.namespace}" has no valid current policy`);
      const p = profileFor(input.profile, created.client.id);
      const next: PolicyV1 = {
        ...current.policy,
        grants: [...current.policy.grants.filter((g) => g.client_id !== created.client.id), p.grant],
        create_rules: [...current.policy.create_rules.filter((r) => r.client_id !== created.client.id), ...p.create_rules],
      };
      deps.policiesRepo.apply(input.namespace, next, auditActor(actor));
      deps.auditRepo.log({ namespace: input.namespace, clientId: auditActor(actor), action: 'control.policy.apply', outcome: 'allow', details: { version: current.version + 1, target: created.client.id } });
    }
    return created;
  }

  function setAgentDisabled(actor: ControlActor, id: string, disabled: boolean): boolean {
    assertAdmin(actor);
    const target = deps.clientsRepo.get(id);
    if (!target) return false;
    const ok = deps.clientsRepo.setDisabled(id, disabled);
    if (ok) {
      deps.auditRepo.log({ namespace: target.namespace, clientId: auditActor(actor), action: disabled ? 'control.agent.disable' : 'control.agent.enable', outcome: 'allow', details: { target: id } });
    }
    return ok;
  }

  function createEnrollment(actor: ControlActor, clientId: string) {
    assertAdmin(actor);
    const target = deps.clientsRepo.get(clientId);
    if (!target) throw new Error(`no client with id "${clientId}"`);
    if (target.principal_kind === 'human') throw new Error('enrollment is for agent/service clients');
    const result = deps.enrollmentsRepo.create(clientId, actor.principal.id);
    deps.auditRepo.log({ namespace: target.namespace, clientId: auditActor(actor), action: 'control.agent.enrollment.create', outcome: 'allow', details: { target: clientId, enrollment_id: result.id } });
    return result;
  }

  function reEnroll(actor: ControlActor, clientId: string) {
    assertAdmin(actor);
    const target = deps.clientsRepo.get(clientId);
    if (!target) throw new Error(`no client with id "${clientId}"`);
    if (target.principal_kind === 'human') throw new Error('enrollment is for agent/service clients');
    deps.enrollmentsRepo.revokePendingForClient(clientId);
    const result = deps.enrollmentsRepo.create(clientId, actor.principal.id);
    deps.auditRepo.log({ namespace: target.namespace, clientId: auditActor(actor), action: 'control.agent.reenroll', outcome: 'allow', details: { target: clientId, enrollment_id: result.id } });
    return result;
  }

  function revokeEnrollment(actor: ControlActor, id: string): boolean {
    assertAdmin(actor);
    const ok = deps.enrollmentsRepo.revoke(id);
    deps.auditRepo.log({ namespace: '*', clientId: auditActor(actor), action: 'control.agent.enrollment.revoke', outcome: ok ? 'allow' : 'deny', details: { enrollment_id: id } });
    return ok;
  }

  function linkClient(actor: ControlActor, principalId: string, clientId: string): void {
    assertAdmin(actor);
    const principal = deps.webPrincipalsRepo.get(principalId);
    const client = deps.clientsRepo.get(clientId);
    if (!principal || !client) throw new Error('principal or client not found');
    deps.webPrincipalsRepo.linkClient(principalId, client, auditActor(actor));
    deps.auditRepo.log({ namespace: client.namespace, clientId: auditActor(actor), action: 'web.principal.link_client', outcome: 'allow', details: { principal_id: principalId, target: clientId } });
  }

  function exchangeEnrollment(code: string) {
    const result = deps.enrollmentsRepo.exchange(code);
    if (!result) deps.enrollmentsRepo.recordFailed(code);
    if (result) {
      const target = deps.clientsRepo.get(result.clientId);
      deps.auditRepo.log({ namespace: target?.namespace ?? '*', clientId: `enrollment:${result.enrollmentId}`, action: 'control.agent.enrollment.exchange', outcome: 'allow', details: { target: result.clientId, enrollment_id: result.enrollmentId } });
    }
    return result;
  }

  return { createAgent, setAgentDisabled, createEnrollment, reEnroll, revokeEnrollment, linkClient, exchangeEnrollment };
}

export type ControlCommands = ReturnType<typeof createControlCommands>;
