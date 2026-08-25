using {sap.capire.bookshop as my} from '../db/schema';

service AdminService {

  @n8n.process.start: {
    path: 'annotation-test-book-created',
    on: 'CREATE'
  }
  entity Books   as projection on my.Books;

  @n8n.process.start: {
    path: 'annotation-test-author-read',
    method: 'GET',
    on: 'READ',
    if: (ID = 101),
    inputs: [ $self.ID, $self.name ]
  }
  entity Authors as projection on my.Authors;

  // Record form with conditional dispatch and explicit input mapping.
  @n8n.process.start: [
    {
      path: 'annotation-test-order-shipped',
      on: 'UPDATE',
      if: (status = 'shipped'),
      inputs: [ $self.ID, $self.quantity, $self.book_ID ]
    },
    {
      path: 'annotation-test-order-deleted',
      on: 'DELETE',
      if: (status = 'new'),
      inputs: [ $self.ID, $self.quantity, $self.status ]
    }
  ]
  entity Orders  as projection on my.Orders;

  // Array form — two triggers registered via a single annotation.
  @n8n.process.start: [
    { path: 'annotation-test-shelf-created', on: 'CREATE' },
    { path: 'annotation-test-shelf-deleted', on: 'DELETE' },
    { path: 'annotation-test-shelf-no-on' },
    { path: 'annotation-test-shelf-bad-if', on: 'CREATE', if: 'test > 5' }
  ]
  entity Shelves as projection on my.Shelves;
}
