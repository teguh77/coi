import { format, getMonth } from 'date-fns';
import handler from '@src/helpers/handler';
import auth from '@src/middlewares/auth';
import prisma from 'db';

const monthName = ['jan', 'feb', 'mar', 'apr', 'mei', 'jun', 'jul', 'agu', 'sep', 'okt', 'nov', 'des'];

interface IOrder {
  products: [{ productId: string | null; quantity: number | null }];
}

type Num = {
  max: number;
};

const today = format(new Date(), 'yyyyMMdd');

async function createReferenceNumber() {
  try {
    const nums = await prisma.$queryRaw<Num[]>`SELECT max(right(reference_number, 6)) FROM delivery_notes`;
    let n;
    nums.forEach((num) => {
      if (num.max !== null) {
        const zeroPad = (number: number, places) => String(number).padStart(places, '0');
        const finalNum = Number(num.max) + 1;
        n = zeroPad(finalNum, 6);
      } else {
        n = null;
      }
    });
    if (n != null) return `DN${today}${n}`;
    return null;
  } catch (error) {
    throw new Error(error);
  }
}

const updateLatestQuantity = async (productId) => {
  const product = await prisma.product.findUnique({ where: { id: productId }, include: { stocks: true } });
  const latestQuantity = await Array.from(product.stocks, (q) => q.quantity).reduce((acc, a) => acc + a);
  await prisma.product.update({
    where: {
      id: productId,
    },
    data: {
      latestQuantity,
    },
  });
};

export default handler()
  .use(auth)
  .post(async (req, res) => {
    const { products }: IOrder = req.body;
    const { userId } = req.user;
    let difference = 0;

    function updateDifference(substraction) {
      difference -= substraction;
    }

    function setDifferenceValue(value) {
      difference = value;
    }

    try {
      const order = await prisma.order.create({
        data: {
          userId,
        },
      });
      products.forEach(async (p) => {
        const product = await prisma.product.findUnique({
          where: { id: p.productId },
          include: {
            stocks: true,
            category: true,
          },
        });

        async function updateStock() {
          async function start() {
            const myproduct = await prisma.product.findUnique({
              where: { id: p.productId },
              include: {
                stocks: true,
                category: true,
              },
            });
            const farthest2 = myproduct.stocks
              .filter((v) => v.quantity !== 0)
              .reduce((a, b) => (a.createdAt < b.createdAt ? a : b));
            if (difference > 0) {
              if (farthest2.quantity >= difference) {
                const updated = prisma.stock.update({
                  where: { id: farthest2.id },
                  data: { quantity: farthest2.quantity - difference },
                });
                await prisma.$transaction([updated]).then(() => updateLatestQuantity(myproduct.id));
                return;
              }

              updateDifference(farthest2.quantity);
              const updated = prisma.stock.update({
                where: { id: farthest2.id },
                data: { quantity: farthest2.quantity - farthest2.quantity },
              });
              await prisma.$transaction([updated]).then(() => {
                updateLatestQuantity(myproduct.id);
                start();
              });
            }
          }
          if (difference === 0) {
            const myproduct = await prisma.product.findUnique({
              where: { id: p.productId },
              include: {
                stocks: true,
                category: true,
              },
            });
            const farthest1 = myproduct.stocks
              .filter((v) => v.quantity !== 0)
              .reduce((a, b) => (a.createdAt < b.createdAt ? a : b));
            if (farthest1.quantity >= p.quantity) {
              const updated = prisma.stock.update({
                where: { id: farthest1.id },
                data: { quantity: farthest1.quantity - p.quantity },
              });
              await prisma.$transaction([updated]).then(() => updateLatestQuantity(myproduct.id));
              return;
            }
            const updated = prisma.stock.update({
              where: { id: farthest1.id },
              data: { quantity: farthest1.quantity - farthest1.quantity },
            });
            setDifferenceValue(p.quantity - farthest1.quantity);
            await prisma.$transaction([updated]).then(() => {
              updateLatestQuantity(myproduct.id);
              start();
            });
          }
        }
        updateStock();
        const latestProduct = product.stocks.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
        await prisma.stockOut.create({
          data: {
            productId: product.id,
            price: latestProduct.price,
            quantity: p.quantity,
            userId,
            category: product.category.title,
            createdMonth: monthName[getMonth(new Date())],
          },
        });

        await prisma.cart.create({
          data: {
            productName: product.name,
            productCode: product.code,
            productCategory: product.category.title,
            productQuantity: p.quantity,
            orderId: (await order).id,
          },
        });
      });
      await prisma.deliveryNote.create({
        data: {
          referenceNumber:
            (await createReferenceNumber()) != null ? ((await createReferenceNumber()) as string) : `DN${today}000001`,
          orderId: (await order).id,
        },
      });
      return res.json({ message: 'Order created' });
    } catch (error) {
      return res.status(500).json({ message: 'Something went wrong' });
    }
  })
  .get(async (_, res) => {
    try {
      const cart = await prisma.order.findMany({
        include: {
          carts: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
      });
      return res.json(cart);
    } catch (error) {
      return res.status(500).json({ message: 'Something went wrong' });
    }
  });