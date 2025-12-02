export default function casingExcept(targetVal, _opts, path) {
  const ignoredPaths = _opts['ignore-paths'];
  const ignoredProperties = _opts['ignore-properties'];
  let res = this.functions.casing(targetVal, _opts);
  // result consists of a message if rule was triggered
  if (res) {
    const pathStr = path.target.join('.');
    let ignored = false;

    if (ignoredPaths) {
      ignored = ignoredPaths.find((exception) => {
        return pathStr.startsWith(exception);
      });
    }

    if (!ignored && ignoredProperties) {
      ignored = ignoredProperties.find((exception) => {
        return targetVal === exception;
      });
    }

    if (ignored) {
      console.log(`Ignoring rule result for ${targetVal}, ${pathStr}`);
      res = undefined;
    }
  }
  return res;
}