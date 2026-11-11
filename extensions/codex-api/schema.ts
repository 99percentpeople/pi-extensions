import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

// Pi 1.5 StringEnum uses pi-schema; retain TypeBox inference without anyOf/const.
export function stringEnum<const T extends readonly string[]>(values: T, description?: string) {
  return Type.Unsafe<T[number]>(StringEnum(values, { description }));
}
