import fs from 'node:fs';
import path from 'node:path';
import type { UserCredential, ShardingConfig } from '../types/index.js';

export interface ShardPlan {
  podIndex: number;
  totalPods: number;
  assignedVUs: number;
  vuStartIndex: number;
  credentials: UserCredential[];
}

/**
 * Resolves the pod index and total pods from environment variables, CLI, or config.
 */
export function resolveSharding(
  configSharding?: ShardingConfig,
  cliShard?: string
): { podIndex: number; totalPods: number } {
  let podIndex = 0;
  let totalPods = 1;

  // 1. Try CLI flag: e.g. "--shard 0/2", "--shard 1/2", or 1-indexed "--shard 2/2"
  if (cliShard) {
    const parts = cliShard.split('/');
    if (parts.length === 2) {
      let idx = parseInt(parts[0], 10);
      const total = parseInt(parts[1], 10);

      // If idx equals total (e.g. 2/2, 4/4), user is using 1-indexed convention
      if (idx === total && total > 0) {
        idx = total - 1;
      }

      return { podIndex: Math.max(0, idx), totalPods: Math.max(1, total) };
    }
  }

  // 2. Try Environment Variables (Kubernetes, Argo, OpenShift)
  const envIndex =
    process.env.POD_INDEX ??
    process.env.JOB_COMPLETION_INDEX ??
    process.env.ARGO_SHARD_INDEX ??
    process.env.SHARD_INDEX;

  const envTotal =
    process.env.TOTAL_PODS ??
    process.env.JOB_COMPLETIONS ??
    process.env.PARALLELISM ??
    process.env.SHARDS_TOTAL;

  if (envIndex !== undefined) {
    const parsedIdx = parseInt(envIndex, 10);
    if (!Number.isNaN(parsedIdx)) {
      podIndex = parsedIdx;
    }
  }

  if (envTotal !== undefined) {
    const parsedTotal = parseInt(envTotal, 10);
    if (!Number.isNaN(parsedTotal) && parsedTotal > 0) {
      totalPods = parsedTotal;
    }
  }

  // 3. Fallback to config values if provided
  if (configSharding?.podIndex !== undefined) {
    podIndex = configSharding.podIndex;
  }
  if (configSharding?.totalPods !== undefined) {
    totalPods = configSharding.totalPods;
  }

  if (podIndex >= totalPods) {
    throw new Error(
      `podIndex (${podIndex}) must be strictly less than totalPods (${totalPods}).`
    );
  }

  return { podIndex, totalPods };
}

/**
 * Loads user credentials from an inline array, JSON file, or CSV file.
 */
export function loadCredentials(usersInput?: UserCredential[] | string): UserCredential[] {
  if (!usersInput) {
    return [];
  }

  if (Array.isArray(usersInput)) {
    return usersInput;
  }

  const resolvedPath = path.resolve(process.cwd(), usersInput);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Credentials file not found at: ${resolvedPath}`);
  }

  const rawContent = fs.readFileSync(resolvedPath, 'utf-8').trim();

  // JSON format
  if (resolvedPath.endsWith('.json')) {
    const parsed = JSON.parse(rawContent);
    if (!Array.isArray(parsed)) {
      throw new Error(`Expected JSON file ${usersInput} to contain an array of user objects.`);
    }
    return parsed;
  }

  // Simple CSV format: username,password or header row
  const lines = rawContent.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const firstLine = lines[0].toLowerCase();
  const hasHeader = firstLine.includes('user') || firstLine.includes('password');
  const startIdx = hasHeader ? 1 : 0;

  const users: UserCredential[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const cols = lines[i].split(',').map((c) => c.trim().replace(/^["']|["']$/g, ''));
    if (cols.length >= 2) {
      users.push({
        username: cols[0],
        password: cols[1],
      });
    }
  }

  return users;
}

/**
 * Divides target total VUs and unique user credentials across pods without collision.
 */
export function calculateShardPlan(
  targetTotalVUs: number,
  podIndex: number,
  totalPods: number,
  allUsers: UserCredential[]
): ShardPlan {
  // Fair distribution of VUs across pods
  const baseVUs = Math.floor(targetTotalVUs / totalPods);
  const remainder = targetTotalVUs % totalPods;

  // Pods with index < remainder take 1 extra VU
  const assignedVUs = baseVUs + (podIndex < remainder ? 1 : 0);

  // Calculate VU start offset across the entire fleet
  let vuStartIndex = 0;
  for (let p = 0; p < podIndex; p++) {
    vuStartIndex += baseVUs + (p < remainder ? 1 : 0);
  }

  // User Credential Sharding: Disjoint subset per pod
  let shardCredentials: UserCredential[] = [];
  if (allUsers.length > 0) {
    if (allUsers.length >= targetTotalVUs) {
      // Direct 1-to-1 disjoint allocation: Each VU in this pod gets its unique account
      shardCredentials = allUsers.slice(vuStartIndex, vuStartIndex + assignedVUs);
    } else {
      // If user list is smaller than total VUs, shard the user list across pods
      const usersPerPod = Math.floor(allUsers.length / totalPods);
      const userRem = allUsers.length % totalPods;
      const podUserCount = usersPerPod + (podIndex < userRem ? 1 : 0);

      let userStartIndex = 0;
      for (let p = 0; p < podIndex; p++) {
        userStartIndex += usersPerPod + (p < userRem ? 1 : 0);
      }

      shardCredentials = allUsers.slice(userStartIndex, userStartIndex + podUserCount);
    }
  }

  return {
    podIndex,
    totalPods,
    assignedVUs,
    vuStartIndex,
    credentials: shardCredentials,
  };
}
