// Logs recorded with plain `logread` (in Docker, in UTC), as `logread -t`
// prints them: each line's epoch, seconds and ms, after its date.
export const withEpochs = (text: string) =>
  text.replace(
    /^(\w{3} (\w{3}) +(\d+) (\d\d:\d\d:\d\d) (\d{4})) /gm,
    (_, date: string, month: string, day: string, time: string, year: string) =>
      `${date} [${Date.parse(`${month} ${day} ${year} ${time} UTC`) / 1000}.000] `
  );
