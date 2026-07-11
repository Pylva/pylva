export function splitClickHouseStatements(content: string): string[] {
  return content
    .split(/;\s*(?:\r?\n\s*){2,}/)
    .map((statement) => statement.trim())
    .filter(hasExecutableSql);
}

function hasExecutableSql(statement: string): boolean {
  return statement.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith('--');
  });
}
