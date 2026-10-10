// Resolves when `check` is true. A fact that lands between the first look and the subscription is seen on the second look.
export function whenTrue(check: () => boolean, subscribe: (fn: () => void) => () => void): Promise<void> {
  if (check()) return Promise.resolve();
  return new Promise(resolve => {
    let stop = () => {};
    const onEvent = () => {
      if (!check()) return;
      stop();
      resolve();
    };
    stop = subscribe(onEvent);
    if (check()) { stop(); resolve(); }
  });
}
