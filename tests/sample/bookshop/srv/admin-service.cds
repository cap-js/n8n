using { sample.bookshop as my } from '../db/schema';

service AdminService {

  // String shorthand — fires the `book-created` webhook on CREATE + UPDATE.
  @n8n.trigger: 'book-created'
  entity Books as projection on my.Books;

  // Record form with conditional dispatch and explicit input mapping.
  @n8n.trigger: {
    workflow: 'order-shipped',
    on: 'UPDATE',
    if: (status = 'shipped'),
    inputs: [
      $self.ID,
      $self.quantity,
      { path: $self.book_ID, as: 'bookId' }
    ]
  }
  entity Orders as projection on my.Orders;
}
