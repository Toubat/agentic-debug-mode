const CANONICAL_GENERATED_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isCanonicalSessionId(value: string): boolean {
  return CANONICAL_GENERATED_UUID.test(value);
}
