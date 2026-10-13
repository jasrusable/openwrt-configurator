// Reading a setting rather than editing it: showing children while it holds
// a value, and its value as text.
import { ReactNode } from "react";
import { Intent } from "../../../../src/intent/schema";
import { IntentField, useDraftValue, ValueAt } from "../draft";

/** Shows its children only while a setting has a value (`is`) or passes `test`. */
export const When = ({
  name,
  is,
  test,
  children,
}: {
  name: IntentField;
  is?: unknown;
  test?: (value: unknown) => boolean;
  children: ReactNode;
}) => {
  const value = useDraftValue(name);
  return (test ? test(value) : value === is) ? <>{children}</> : null;
};

/**
 * The live value of a setting, e.g. in a table cell or a title. `format`
 * turns it into something to read; empty values show `fallback`.
 */
export const Value = <P extends IntentField>({
  name,
  fallback,
  format,
}: {
  name: P;
  fallback?: ReactNode;
  format?: (value: ValueAt<Intent, P> | undefined) => ReactNode;
}) => {
  const value = useDraftValue(name);
  const shown = format ? format(value) : (value as ReactNode);
  return <>{shown === undefined || shown === "" ? fallback : shown}</>;
};
