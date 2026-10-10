// The whole UI edits one form: the intent file. It validates with the same
// zod schema the server does, so most mistakes are caught as you type, and
// the server's answer to a save maps back onto the same field names.
import { zodResolver } from "@hookform/resolvers/zod";
import { notifications } from "@mantine/notifications";
import { ReactNode, useEffect } from "react";
import { FieldPath, FormProvider, useForm, useFormContext } from "react-hook-form";
import { Intent, intentSchema } from "../../../src/intent/schema";
import { SaveError } from "../data/api";
import { useSaveIntent } from "../data/intent";

export type IntentField = FieldPath<Intent>;

/** A form over a whole intent, checked by the same schema as the server. */
export const useIntentFormState = (intent: Intent) =>
  useForm<Intent>({
    resolver: zodResolver(intentSchema) as never,
    defaultValues: intent,
    mode: "onTouched",
  });

/** The draft: what Save writes. Every field on every page edits it. */
export const IntentForm = ({
  intent,
  children,
}: {
  intent: Intent;
  children: ReactNode;
}) => {
  const form = useIntentFormState(intent);
  // A file edited by hand, or saved under older rules, can already be
  // invalid: show its problems at once, not only once a field is touched.
  useEffect(() => {
    form.trigger();
  }, [form]);
  return <FormProvider {...form}>{children}</FormProvider>;
};

export const useIntentForm = () => useFormContext<Intent>();

/** Save and revert, for the toolbar. */
export const useSaveActions = () => {
  const form = useIntentForm();
  const save = useSaveIntent();

  const submit = form.handleSubmit(
    async (values) => {
      try {
        form.reset(await save.mutateAsync(values));
        notifications.show({ message: "Saved.", color: "green" });
      } catch (e) {
        if (e instanceof SaveError) {
          e.issues.forEach((issue) =>
            form.setError(issue.path as IntentField, { message: issue.message })
          );
        }
        notifications.show({ message: (e as Error).message, color: "red" });
      }
    },
    () =>
      notifications.show({ message: "Some settings need fixing.", color: "red" })
  );

  return {
    save: submit,
    revert: () => form.reset(),
    dirty: form.formState.isDirty,
    valid: form.formState.isValid,
    saving: save.isPending,
  };
};
