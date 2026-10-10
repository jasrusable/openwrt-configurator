// A list in the intent (Wi-Fi networks, devices) as one section per item,
// with Add and Remove. The page supplies only each item's title and fields.
import { Button, Group } from "@mantine/core";
import { ReactNode } from "react";
import { FieldArrayPath, useFieldArray } from "react-hook-form";
import { Intent } from "../../../src/intent/schema";
import { Section } from "../kit/layout";

type ListName = FieldArrayPath<Intent>;

export const ListSections = <N extends ListName>({
  name,
  newItem,
  addLabel,
  title,
  canRemove = () => true,
  children,
}: {
  name: N;
  /** What Add appends. */
  newItem: () => Intent[N] extends (infer Item)[] ? Item : never;
  addLabel: string;
  title: (index: number) => ReactNode;
  canRemove?: (index: number) => boolean;
  /** The fields of item `index`, named `${name}.${index}.<field>`. */
  children: (index: number) => ReactNode;
}) => {
  const { fields, append, remove } = useFieldArray<Intent, N>({ name });
  return (
    <>
      {fields.map((item, index) => (
        <Section
          key={item.id}
          title={title(index)}
          actions={
            canRemove(index) && (
              <Button
                variant="subtle"
                color="red"
                size="compact-sm"
                onClick={() => remove(index)}
              >
                Remove
              </Button>
            )
          }
        >
          {children(index)}
        </Section>
      ))}
      <Group>
        <Button variant="light" onClick={() => append(newItem() as never)}>
          {addLabel}
        </Button>
      </Group>
    </>
  );
};
