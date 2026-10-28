/** How dangerous a target is: production, pre-production, a dev sandbox, or unknown. */
export type Tier = 'prod' | 'caution' | 'safe' | 'neutral'

export type KubeInfo = {
  /** The current context's name as kubeconfig has it (an EKS ARN, say). */
  context: string
  /** A short display name: the cluster part of an ARN, else the context. */
  name: string
  namespace?: string
  tier: Tier
  /** The environment word found in it, upper-cased: PRODUCTION, SANDBOX1... */
  env?: string
}

export type AwsInfo = {
  profile: string
  region?: string
  /** Epoch ms when the profile's SSO token expires; absent for non-SSO profiles. */
  ssoExpiresAt?: number
  tier: Tier
  env?: string
}

export type GitInfo = {
  branch: string
  /** Uncommitted entries of any kind: staged, modified, untracked or conflicted. */
  changes: number
  /** Entries with changes staged for the next commit. */
  staged: number
  /** Entries with changes not staged yet. */
  unstaged: number
  untracked: number
  conflicted: number
  ahead: number
  behind: number
}

export type Where = { kube?: KubeInfo; aws?: AwsInfo; git?: GitInfo }

declare module 'claude-code' {
  interface PluginState {
    'where-am-i': {
      /** Shape-tagged (the engine's `Shaped`), so a reload from 0.2.0's shape reads as absent. */
      where: { shape: string; value: Where | null }
      isHidden: boolean
    }
  }
}
