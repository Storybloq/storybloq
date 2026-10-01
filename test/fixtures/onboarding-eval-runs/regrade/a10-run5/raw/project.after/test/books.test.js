import { test } from "node:test";
import assert from "node:assert/strict";
import { addBook, listBooks } from "../src/books.js";

test("addBook stores a book with an id", () => {
  const book = addBook({ title: "Holes", author: "Louis Sachar" });
  assert.equal(book.id, 1);
  assert.equal(listBooks().length, 1);
});
