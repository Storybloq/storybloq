const books = [];
let nextId = 1;

export function listBooks() {
  return books;
}

export function addBook({ title, author }) {
  if (!title) throw new Error("title is required");
  const book = { id: nextId++, title, author: author ?? "" };
  books.push(book);
  return book;
}
