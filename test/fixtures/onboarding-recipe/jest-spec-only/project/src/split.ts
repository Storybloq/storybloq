export function split(total: number, people: number): number {
  return Math.round((total / people) * 100) / 100;
}
