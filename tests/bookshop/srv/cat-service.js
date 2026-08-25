const cds = require("@sap/cds")

module.exports = class CatalogService extends cds.ApplicationService {
  init() {
    const { Books } = cds.entities("sap.capire.bookshop")
    const { ListOfBooks } = this.entities

    // Add some discount for overstocked books
    this.after("each", ListOfBooks, (book) => {
      if (book.stock > 111) book.title += ` -- 11% discount!`
    })

    // Reduce stock of ordered books if available stock suffices
    this.on("submitOrder", async (req) => {
      let { book: id, quantity } = req.data
      let book = await SELECT.one.from(Books, id, (b) => { b.stock, b.price })

      // Validate input data
      if (!book) return req.error(404, `Book #${id} doesn't exist`)
      if (quantity < 1) return req.error(400, `quantity has to be 1 or more`)
      if (!book.stock || quantity > book.stock)
        return req.error(409, `${quantity} exceeds stock for book #${id}`)

      // Reduce stock in database and return updated stock value
      const new_stock = book.stock - quantity
      const order_amount = quantity * book.price
      await UPDATE(Books, id).with({ stock: new_stock })

      // Stash computed values for the after-handler
      req.context._orderInfo = { order_amount, new_stock }
      return { stock: new_stock }
    })

    // Emit event when an order has been submitted
    this.after("submitOrder", async (_, req) => {
      let { book, quantity } = req.data
      await this.emit("OrderedBook", { book, quantity, buyer: req.user.id })
    })

    // Trigger n8n workflow after order submission
    this.after("submitOrder", async (_, req) => {
      const { book, quantity } = req.data
      const { order_amount, new_stock } = req.context._orderInfo ?? {}
      const n8n = await cds.connect.to("n8n")
      await n8n.trigger({
        path: "book-order",
        payload: { book, quantity, buyer: req.user.id, order_amount, new_stock },
      })
    })

    // Delegate requests to the underlying generic service
    return super.init()
  }
}
