/** Provider options are write-only on public CRUD surfaces: custom providers
 * can hide credentials under arbitrary names, URLs or nested header objects. */
export function publicBlueprint<T extends object>(blueprint: T): Omit<T, "providerConfig"> {
  const { providerConfig: _private, ...visible } = blueprint as T & { providerConfig?: unknown };
  return visible;
}
