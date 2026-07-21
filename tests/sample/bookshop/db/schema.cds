namespace sample.bookshop;

using { cuid, managed } from '@sap/cds/common';

entity Books : cuid, managed {
  title  : String(200);
  author : String(200);
  stock  : Integer default 0;
  price  : Decimal(9, 2);
}

entity Orders : cuid, managed {
  book     : Association to Books;
  quantity : Integer;
  status   : String(20) default 'new'; // new | shipped | cancelled
}
