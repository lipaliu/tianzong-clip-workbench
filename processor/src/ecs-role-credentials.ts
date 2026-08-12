import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from "@aws-sdk/types";

const metadataBaseUrl = "http://100.96.0.96/latest";
const tokenTtlSeconds = 300;
const refreshSkewMs = 5 * 60 * 1000;

type VolcRoleCredentialResponse = {
  AccessKeyId: string;
  SecretAccessKey: string;
  SessionToken: string;
  ExpiredTime: string;
};

function assertMetadataCredential(value: unknown): asserts value is VolcRoleCredentialResponse {
  if (!value || typeof value !== "object") {
    throw new Error("ECS metadata returned an invalid role credential payload");
  }
  const record = value as Record<string, unknown>;
  for (const field of ["AccessKeyId", "SecretAccessKey", "SessionToken", "ExpiredTime"]) {
    if (typeof record[field] !== "string" || !record[field]) {
      throw new Error(`ECS metadata role credential is missing ${field}`);
    }
  }
}

async function fetchMetadataToken(): Promise<string> {
  const response = await fetch(`${metadataBaseUrl}/api/token`, {
    method: "PUT",
    headers: { "X-volc-ecs-metadata-token-ttl-seconds": String(tokenTtlSeconds) },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`ECS metadata token request failed with HTTP ${response.status}`);
  }
  const token = (await response.text()).trim();
  if (!token) throw new Error("ECS metadata token response was empty");
  return token;
}

async function fetchRoleCredential(roleName: string): Promise<AwsCredentialIdentity> {
  const token = await fetchMetadataToken();
  const response = await fetch(
    `${metadataBaseUrl}/iam/security_credentials/${encodeURIComponent(roleName)}`,
    {
      headers: { "X-volc-ecs-metadata-token": token },
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!response.ok) {
    throw new Error(`ECS role credential request failed with HTTP ${response.status}`);
  }
  const payload: unknown = await response.json();
  assertMetadataCredential(payload);
  const expiration = new Date(payload.ExpiredTime);
  if (Number.isNaN(expiration.getTime())) {
    throw new Error("ECS metadata role credential has an invalid ExpiredTime");
  }
  return {
    accessKeyId: payload.AccessKeyId,
    secretAccessKey: payload.SecretAccessKey,
    sessionToken: payload.SessionToken,
    expiration,
  };
}

/**
 * Returns a refreshable AWS SDK credential provider backed by Volcengine ECS
 * IMDSv2. The provider never persists an Access Key or Secret Access Key.
 */
export function createEcsRoleCredentialProvider(roleName: string): AwsCredentialIdentityProvider {
  let cached: AwsCredentialIdentity | undefined;
  let inFlight: Promise<AwsCredentialIdentity> | undefined;

  return async (): Promise<AwsCredentialIdentity> => {
    const expiration = cached?.expiration?.getTime();
    if (cached && expiration && expiration - Date.now() > refreshSkewMs) return cached;

    if (!inFlight) {
      inFlight = fetchRoleCredential(roleName).then((credential) => {
        cached = credential;
        return credential;
      });
    }
    try {
      return await inFlight;
    } finally {
      inFlight = undefined;
    }
  };
}
