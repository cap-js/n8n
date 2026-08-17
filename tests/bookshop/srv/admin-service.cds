using {sap.capire.bookshop as my} from '../db/schema';

service AdminService {

  // String shorthand - fires the `book-created` webhook on all CRUD events.
  @n8n.process.start: 'book-created'
  entity Books   as projection on my.Books;

  entity Authors as projection on my.Authors;

  // Record form with conditional dispatch and explicit input mapping.
  @n8n.process.start: {
    path: 'order-shipped',
    on: 'UPDATE',
    if: (status = 'shipped'),
    inputs: [
      $self.ID,
      $self.quantity,
      $self.book_ID
    ]
  }
  // The DELETE trigger relies on the plugin's prefetch: at after-handler
  // time the row is already gone, so we grab it in a before-handler and
  // stash it on the request context.
  @n8n.process.start #deleted: {
    path: 'order-deleted',
    on: 'DELETE',
    inputs: [ $self.ID, $self.quantity, $self.status ]
  }
  entity Orders  as projection on my.Orders;
}
