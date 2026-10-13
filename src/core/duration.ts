// A wait in plain words (from Where's My Swap's trace module, where it names delays).

export function describeDuration(sec: number): string {
  if (sec < 90) return `${sec} s`;
  if (sec < 5_400) return `${Math.round(sec / 60)} min`;
  if (sec < 172_800) return `${Math.round(sec / 3_600)} h`;
  return `${Math.round(sec / 86_400)} days`;
}
