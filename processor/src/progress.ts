export function editorialWindowProgressMessage(
  providerName: string,
  completed: number,
  total: number,
): string {
  if (!providerName.trim()) throw new Error("provider name is required");
  if (!Number.isInteger(completed) || !Number.isInteger(total)) {
    throw new Error("editorial window progress must use integer counts");
  }
  if (total <= 0 || completed < 0 || completed > total) {
    throw new Error("editorial window progress counts are invalid");
  }
  return `${providerName} 独立分析窗口 ${completed}/${total} 已完成。`;
}
