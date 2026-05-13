/**
 * api/services/hasura/hasuraClient.ts
 *
 * Thin Hasura GraphQL client.
 * All Hasura-specific code stays inside this directory — never leaks out.
 */

export async function hasuraQuery<T = unknown>(
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  const url = process.env.HASURA_URL;
  const secret = process.env.HASURA_ADMIN_SECRET;

  if (!url || !secret) {
    throw new Error("[Hasura] HASURA_URL or HASURA_ADMIN_SECRET is not set");
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-hasura-admin-secret": secret,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`[Hasura] HTTP ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };

  if (json.errors && json.errors.length > 0) {
    throw new Error(`[Hasura] GraphQL error: ${json.errors[0].message}`);
  }

  return json.data as T;
}
