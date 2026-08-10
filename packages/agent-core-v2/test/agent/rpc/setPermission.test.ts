import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IAgentScopeHandle } from '#/_base/di/scope';
import { Event } from '#/_base/event';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import {
  agentService,
  createTestAgent,
  sessionService,
  telemetryServices,
  type TestAgentContext,
} from '../../harness';

// A minimal `IAgentLifecycleService` stub whose `broadcastPermissionMode` is a
// spy, so a test can observe whether the RPC fans a mode change out without
// depending on `broadcastPermissionMode`'s own effect (covered separately in
// `session/agentLifecycle/agentLifecycle.test.ts`).
function lifecycleStub(broadcastPermissionMode: (mode: PermissionMode) => void): IAgentLifecycleService {
  return {
    _serviceBrand: undefined,
    onDidCreate: Event.None as Event<IAgentScopeHandle>,
    onDidDispose: Event.None as Event<string>,
    create: () => Promise.reject(new Error('IAgentLifecycleService.create is not supported here')),
    fork: () => Promise.reject(new Error('IAgentLifecycleService.fork is not supported here')),
    get: () => undefined,
    list: () => [],
    remove: () => Promise.resolve(),
    broadcastPermissionMode,
  };
}

describe('setPermission RPC', () => {
  let ctx: TestAgentContext;
  let records: TelemetryRecord[];

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('applies the mode to the agent and tracks the afk toggle', async () => {
    records = [];
    ctx = createTestAgent(telemetryServices(recordingTelemetry(records)));

    await ctx.rpc.setPermission({ mode: 'auto' });

    expect(ctx.get(IAgentPermissionModeService).mode).toBe('auto');
    expect(records).toContainEqual({ event: 'afk_toggle', properties: { agent_id: 'main', enabled: true } });
  });

  it('tracks the yolo toggle on enter and exit', async () => {
    records = [];
    ctx = createTestAgent(telemetryServices(recordingTelemetry(records)));

    await ctx.rpc.setPermission({ mode: 'yolo' });
    await ctx.rpc.setPermission({ mode: 'manual' });

    expect(ctx.get(IAgentPermissionModeService).mode).toBe('manual');
    expect(records).toContainEqual({ event: 'yolo_toggle', properties: { agent_id: 'main', enabled: true } });
    expect(records).toContainEqual({ event: 'yolo_toggle', properties: { agent_id: 'main', enabled: false } });
  });

  it('fans the new mode out to live subagents when the scope is the main agent', async () => {
    const broadcastPermissionMode = vi.fn();
    ctx = createTestAgent(sessionService(IAgentLifecycleService, lifecycleStub(broadcastPermissionMode)));

    await ctx.rpc.setPermission({ mode: 'auto' });

    expect(broadcastPermissionMode).toHaveBeenCalledWith('auto');
  });

  it('does not fan the mode out when the scope is a subagent', async () => {
    const broadcastPermissionMode = vi.fn();
    ctx = createTestAgent(
      sessionService(IAgentLifecycleService, lifecycleStub(broadcastPermissionMode)),
      agentService(IAgentScopeContext, makeAgentScopeContext({ agentId: 'agent-child', agentScope: '' })),
    );

    await ctx.rpc.setPermission({ mode: 'auto' });

    expect(ctx.get(IAgentPermissionModeService).mode).toBe('auto');
    expect(broadcastPermissionMode).not.toHaveBeenCalled();
  });
});
