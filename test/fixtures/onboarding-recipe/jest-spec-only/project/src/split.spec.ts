import { split } from "./split";

test("splits evenly", () => {
  expect(split(30, 3)).toBe(10);
});
