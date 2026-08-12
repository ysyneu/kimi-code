import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const WorkspaceErrors = {
  codes: {
    WORKSPACE_NOT_FOUND: 'workspace.not_found',
    WORKSPACE_ROOT_TIMEOUT: 'workspace.root_timeout',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(WorkspaceErrors);
