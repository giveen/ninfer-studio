/** Classify one unified-diff line so we can color it. */
export function lineClass(line: string): string {
  if (line.startsWith('+')) return 'text-ok bg-ok/[0.06]';
  if (line.startsWith('-')) return 'text-danger bg-danger/[0.06]';
  if (line.startsWith('@@')) return 'text-accent';
  if (
    line.startsWith('diff --git') ||
    line.startsWith('---') ||
    line.startsWith('+++') ||
    line.startsWith('index ') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('similarity') ||
    line.startsWith('rename ') ||
    line.startsWith('old mode') ||
    line.startsWith('new mode') ||
    line.startsWith('Binary ')
  ) {
    return 'text-faint';
  }
  return 'text-ink/75';
}
