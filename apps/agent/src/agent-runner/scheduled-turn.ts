export async function awaitTriggeredTurn<T extends { triggered: boolean }>(
  trigger: () => Promise<T>,
  waitForCompletion: () => Promise<void>,
): Promise<T> {
  const result = await trigger();
  if (result.triggered) {
    await waitForCompletion();
  }
  return result;
}

export async function surfaceRunError(
  sourceKind: string,
  error: unknown,
  surface: (error: unknown) => Promise<void>,
): Promise<void> {
  try {
    await surface(error);
  } catch (surfaceError) {
    if (sourceKind === 'schedule') {
      console.error('[scheduled-turn] failed to surface run error', surfaceError);
      throw error;
    }
    throw surfaceError;
  }
  if (sourceKind === 'schedule') {
    throw error;
  }
}
