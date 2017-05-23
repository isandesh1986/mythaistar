import { Credentials } from 'aws-sdk';
import { ActionConfigurationPropertyList } from 'aws-sdk/clients/codepipeline';
import { AccessControlPolicy } from 'aws-sdk/clients/s3';
import * as _ from 'lodash';
import dynamo from './data-collector/src/adapters/fn-dynamo';
import fn from './data-collector/src/index';
import * as dbtypes from './model/database';
import * as types from './model/interfaces';
import * as util from './utils/utilFunctions';
import * as moment from 'moment';
import * as md5 from 'md5';
import { Mailer } from './utils/mailer';
import * as pug from 'pug';

// Dynamo
/*
const creds = new Credentials('akid', 'secret', 'session');
fn.setDB(dynamo, { endpoint: 'http://localhost:8000/', region: 'us-west-2', credentials: creds });*/
let creds;
if (!process.env.MODE || process.env.MODE.trim() !== 'test') {
    creds = new Credentials('akid', 'secret', 'session');
    fn.setDB(dynamo, { endpoint: 'http://localhost:8000/', region: 'us-west-2', credentials: creds });
} else {
    creds = new Credentials('akid2', 'secret2', 'session2');
    fn.setDB(dynamo, { endpoint: 'http://localhost:8000/', region: 'us-west-2', credentials: creds });
}

const maxPrice = 50;
const dateFormat = 'YYYY-MM-DD HH:mm:ss.SSS';
const bookingExpiration = 1;
const bookingExpirationH = 'hour';
const mailer = new Mailer('Gmail', 'mythaistarrestaurant@gmail.com', 'mythaistarrestaurant2501');

export default {
    /*getDihses: async (callback: (err: types.IError | null, dishes?: types.IDishView[]) => void) => {
        try {
            /* Old way to do this with other database structure
            let tables = await fn.table('Dish').
                map(util.renameProperties("Dish")).
                table('DishIngredient').
                join('DishId', 'IdDish').
                table('Ingredient').
                join('IdIngredient', 'Id').
                reduce((acum: any, elem: any) => {
                    if (acum[elem.DishName]) {
                        acum[elem.DishName].extras.push({ name: elem.Name, price: elem.Price, selected: false });
                    } else {
                        acum[elem.DishName] = {
                            favourite: false,
                            image: elem.DishImage,
                            likes: elem.DishLikes,
                            extras: [{ name: elem.Name, price: elem.Price, selected: false }],
                            orderDescription: elem.DishDescription,
                            orderName: elem.DishName,
                            price: elem.DishPrice,
                        };
                    }
                    return acum;
                }, {}).
                promise();

            let res = util.objectToArray(tables);// *//*

const ingredients: dbtypes.IIngredient[] = await fn.table('Ingredient').promise();

const dishes: types.IDishView[] = await fn.table('Dish').map(util.relationArrayOfIds(ingredients, 'extras', 'id')).
map(util.dishToDishview()).
promise();

callback(null, dishes);
} catch (err) {
callback(err);
}
},*/
    getDishes: async (filter: types.IFilterView,
        callback: (err: types.IError | null, dishes?: types.IDishView[]) => void) => {
        // check filter values. Put the correct if neccessary
        checkFilter(filter);

        try {
            // filter by category
            const catId: string[] | undefined = (filter.categories === null || filter.categories === undefined || filter.categories.length === 0) ?
                undefined :
                filter.categories.map((elem: types.ICategoryView) => elem.id.toString());

            let dishCategories: string[] = [];
            let dishIdSet: Set<string> | undefined;

            // get the dish ids if we are filtering by category
            if (catId) {
                dishCategories = await fn.table('Category', catId).
                    table('DishCategory').
                    join('id', 'idCategory').
                    map((elem: any) => elem.idDish).
                    promise();

                dishIdSet = new Set(dishCategories);

            }

            // filter by fav, TODO: check if user is correct
            if (filter.isFab) {
                // TODO: take id using the authorization token
                const fav = await fn.table('User', '1').
                    promise();

                const s2: Set<string> = new Set(fav.favorites as string[]);

                dishIdSet = (dishIdSet !== undefined) ? util.setIntersection(dishIdSet, s2) : s2;
            }

            // get dishes from database
            if (dishIdSet === undefined || dishIdSet.size > 0) {
                const ingredients: dbtypes.IIngredient[] = await fn.table('Ingredient').promise();

                const dishes: types.IDishView[] = await fn.
                    table('Dish', (dishIdSet !== undefined) ? [...dishIdSet] : undefined).
                    map(util.relationArrayOfIds(ingredients, 'extras', 'id')).
                    map(dishToDishview()).
                    where('price', filter.maxPrice, '<=').
                    filter((o: any) => {
                        return _.lowerCase(o.name).includes(_.lowerCase(filter.searchBy))
                            || _.lowerCase(o.description).includes(_.lowerCase(filter.searchBy));
                    }).
                    promise();

                // TODO: filter by likes
                callback(null, dishes);
            } else {
                callback(null, []);
            }

        } catch (error) {
            console.error(error);
            callback(error);
        }
    },
    createBooking: async (reserv: types.IReservationView,
        callback: (err: types.IError | null, booToken?: string) => void) => {
        const date = moment();
        const bookDate = moment(reserv.date, dateFormat);

        try {
            let table;
            if (reserv.type.name === 'booking') {
                table = await getFreeTable(reserv.date, reserv.assistants);

                if (table === 'error') {
                    callback({ code: 400, message: 'No more tables' });
                    return;
                }
            }

            const booking: dbtypes.IBooking = {
                id: util.getNanoTime().toString(),
                // TODO: get user from session or check if is a guest
                // userId: '1',
                name: reserv.name,
                email: reserv.email,
                bookingToken: 'CB_' + moment().format('YYYYMMDD') + '_' + md5(reserv.email + moment().format('YYYYMMDDHHmmss')),
                bookingDate: bookDate.format(dateFormat),
                expirationDate: bookDate.subtract(1, 'hour').format(dateFormat), // TODO: modify this, maybe add 1 hour or delete this property
                creationDate: date.format(dateFormat),
                canceled: false,
                bookingType: reserv.type.name,
                assistants: (reserv.type.name === 'booking') ? reserv.assistants : undefined,
                table: (reserv.type.name === 'booking') ? table : undefined,
            };

            const inv: dbtypes.IInvitedGuest[] = [];

            if (reserv.type.name === 'invitation' && reserv.guestList.length > 0) {
                // remove possible duplicates
                const emails: Set<string> = new Set(reserv.guestList);

                emails.forEach((elem: string) => {
                    const now = moment();
                    inv.push({
                        id: util.getNanoTime().toString(),
                        idBooking: booking.id,
                        guestToken: 'GB_' + now.format('YYYYMMDD') + '_' + md5(elem + now.format('YYYYMMDDHHmmss')),
                        email: elem,
                        modificationDate: now.format(dateFormat),
                        order: undefined,
                    });
                });

                booking.guestList = inv.map((elem: any): string => elem.id);
            }

            // wait for the insertion and check if there are a exception
            // TODO: tratar los errores
            await fn.insert('Booking', booking).promise();
            if (inv.length > 0 || false) {
                await fn.insert('InvitedGuest', inv).promise();
            }

            callback(null, booking.bookingToken);

            if (reserv.type.name === 'booking') {

            } else {
                mailer.sendEmail(reserv.email, '[MyThaiStar] Booking info', undefined, pug.renderFile('./src/emails/createInvitationHost.pug', {
                    title: 'Invitation created',
                    name: reserv.name,
                    date: bookDate.format('YYYY-MM-DD'),
                    hour: bookDate.format('HH:mm:ss'),
                    guest: reserv.guestList,
                    urlCancel: '#',
                }));

                reserv.guestList.forEach((elem: string) => {
                    const email = pug.renderFile('./src/emails/createInvitationGuest.pug', {
                        title: 'You have been invited',
                        email: elem,
                        name: reserv.name,
                        hostEmail: reserv.email,
                        date: bookDate.format('YYYY-MM-DD'),
                        hour: bookDate.format('HH:mm:ss'),
                        guest: reserv.guestList,
                        urlAcept: '#',
                        urlCancel: '#',
                    });

                    mailer.sendEmail(elem, '[MyThaiStar] Your have a new invitation', email, email);
                });
            }
        } catch (err) {
            console.log(err);
            callback(err);
        }
    },
    createOrder: async (order: types.IOrderView, callback: (err: types.IError | null) => void) => {

        // check if exsist the token
        let reg: any[];

        try {
            if (order.invitationId.startsWith('CB')) {
                reg = await fn.table('Booking').where('bookingToken', order.invitationId, '=').promise();
            } else {
                reg = await fn.table('InvitedGuest').where('guestToken', order.invitationId, '=').promise();
            }

            // Possible errors
            // Not found
            if (reg.length === 0) {
                callback({ code: 400, message: 'No Invitation token given' });
                return;
            }
            // booking canceled
            if (order.invitationId.startsWith('CB')) {
                if (reg[0].canceled !== undefined && reg[0].canceled === true) {
                    callback({ code: 500, message: 'The booking is canceled' });
                    return;
                }
                const bookingDate = moment(reg[0].bookingDate, dateFormat);
                if (bookingDate.diff(moment().add(1, 'hour')) < 0) {
                    callback({ code: 500, message: 'You can not create the order at this time' });
                    return;
                }
            } else {
                const reg2 = await fn.table('Booking', reg[0].idBooking).promise();
                if (reg2[0].canceled !== undefined && reg2[0].canceled === true) {
                    callback({ code: 500, message: 'The booking is canceled' });
                    return;
                }
                const bookingDate = moment(reg2[0].bookingDate, dateFormat);
                if (bookingDate.diff(moment().add(1, 'hour')) < 0) {
                    callback({ code: 500, message: 'You can not create the at this time' });
                    return;
                }
            }
            // Order already registered
            if (reg[0].order !== undefined) {
                callback({ code: 500, message: 'You have a order, cant create a new one' });
                return;
            }
        } catch (err) {
            console.error(err);
            callback({ code: 500, message: 'Database error' });
            return;
        }

        const ord: dbtypes.IOrder = {
            id: util.getNanoTime().toString(),
            lines: (order.lines.length > 0) ? order.lines.map((elem: types.IOrderLineView): dbtypes.IOrderLine => {
                return {
                    idDish: elem.idDish.toString(),
                    extras: (elem.extras.length > 0) ? elem.extras.map((elem2: number) => elem2.toString()) : [],
                    amount: elem.amount,
                    comment: (elem.comment === '') ? undefined : elem.comment,
                };
            }) : [],
            idBooking: (reg[0].idBooking !== undefined) ? reg[0].idBooking : reg[0].id,
            idInvitedGuest: (reg[0].idBooking !== undefined) ? reg[0].id : undefined,
        };

        reg[0].order = ord.id;

        try {
            await fn.insert('Order', ord).promise();
        } catch (err) {
            console.error(err);
            callback({ code: 500, message: 'Database error' });
            return;
        }

        try {
            if (order.invitationId.startsWith('CB')) {
                await fn.insert('Booking', reg[0]).promise();
            } else {
                await fn.insert('InvitedGuest', reg[0]).promise();
            }
        } catch (err) {
            console.error(err);
            callback({ code: 500, message: 'Database error' });
            // undo the previous insert
            fn.delete('Order', ord.id).promise();
            return;
        }

        callback(null);

        const [vat, names] = await calculateVATandOrderName(order);
        console.log(pug.renderFile('./src/emails/order.pug', {
            title: 'Order created',
            email: reg[0].email,
            total: vat,
            urlCancel: '#',
            order:  names,
        }));
        mailer.sendEmail(reg[0].email, '[MyThaiStar] Order info', undefined, pug.renderFile('./src/emails/order.pug', {
            title: 'Order created',
            email: reg[0].email,
            total: vat,
            urlCancel: '#',
            order:  names,
        }));
    },
    cancelOrder: async (order: string, callback: (err: types.IError | null) => void) => {
        let reg: any[];
        try {
            if (order.startsWith('CB')) {
                reg = await fn.table('Booking').where('bookingToken', order, '=').promise();
            } else {
                reg = await fn.table('InvitedGuest').where('guestToken', order, '=').promise();
            }

            // errors
            if (reg.length === 0) {
                callback({ code: 400, message: 'Invalid Invitation token given' });
                return;
            }
            if (order.startsWith('CB')) {
                const bookingDate = moment(reg[0].bookingDate, dateFormat);
                if (bookingDate.diff(moment().add(1, 'hour')) < 0) {
                    callback({ code: 500, message: 'You can not create the order at this time' });
                    return;
                }
            } else {
                const reg2 = await fn.table('Booking', reg[0].idBooking).promise();
                const bookingDate = moment(reg2[0].bookingDate, dateFormat);
                if (bookingDate.diff(moment().add(1, 'hour')) < 0) {
                    callback({ code: 500, message: 'You can not create the order at this time' });
                    return;
                }
            }
        } catch (err) {
            console.error(err);
            callback(err);
            return;
        }

        const oldOrder = reg[0].order;
        reg[0].order = undefined;

        try {
            if (order.startsWith('CB')) {
                await fn.insert('Booking', reg[0]).promise();
            } else {
                await fn.insert('InvitedGuest', reg[0]).promise();
            }
        } catch (err) {
            console.error(err);
            callback(err);
            return;
        }

        try {
            await fn.delete('Order', oldOrder).promise();
        } catch (err) {
            console.error(err);
            callback(err);
            reg[0].order = oldOrder;
            if (order.startsWith('CB')) {
                await fn.insert('Booking', reg[0]).promise();
            } else {
                await fn.insert('InvitedGuest', reg[0]).promise();
            }
            return;
        }

        callback(null);
    },
    cancelInvitation: async (token: string, callback: (err: types.IError | null) => void) => {
        let reg: dbtypes.IBooking[];
        try {
            reg = await fn.table('Booking').where('bookingToken', token, '=').promise();

            // errors
            if (reg.length === 0) {
                callback({ code: 400, message: 'Invalid token given' });
                return;
            }

            if (reg[0].bookingType !== 'invitation') {
                callback({ code: 400, message: 'You can\'t cancel the booking' });
                return;
            }

            const bookingDate = moment(reg[0].bookingDate, dateFormat);
            if (bookingDate.diff(moment().add(1, 'hour')) < 0) {
                callback({ code: 500, message: 'You can\'t cancel the booking at this time' });
                return;
            }

            if (reg[0].canceled) {
                callback({ code: 500, message: 'Already canceled' });
                return;
            }
        } catch (err) {
            console.error(err);
            callback(err);
            return;
        }

        reg[0].canceled = true;

        try {
            await fn.insert('Booking', reg[0]).promise();
        } catch (err) {
            console.error(err);
            callback(err);
            return;
        }

        reg[0].canceled = false;

        try {
            if (reg[0].guestList !== undefined && (reg[0].guestList as string[]).length > 0) {
                await fn.delete('InvitedGuest', (reg[0].guestList as string[])).promise();
            }
        } catch (err) {
            console.error(err);
            callback(err);
            await fn.insert('Booking', reg[0]).promise();
            return;
        }

        try {
            const order = await fn.table('Order').where('idBooking', reg[0].id, '=').promise();

            if (order.length > 0) {
                await fn.delete('Order', order.map((elem: any) => elem.id)).promise();
            }
        } catch (err) {
            console.error(err);
            callback(err);
            await fn.insert('Booking', reg[0]).promise();
            await fn.insert('InvitedGuest', (reg[0].guestList as string[])).promise();
            return;
        }

        callback(null);

        // const reservation = await fn.table('Booking').promise();
        // const invited = await fn.table('InvitedGuest').promise();
        // const order = await fn.table('Order').promise();

        // console.log('\n\n\n');
        // console.log(reservation);
        // console.log('\n\n\n');
        // console.log(invited);
        // console.log('\n\n\n');
        // console.log(order);
        // TODO: send emails

    },
    updateInvitation: async (token: string, response: boolean, callback: (err: types.IError | null) => void) => {
        let reg: dbtypes.IInvitedGuest[];
        try {
            reg = await fn.table('InvitedGuest').where('guestToken', token, '=').promise();

            // errors
            if (reg.length === 0) {
                callback({ code: 400, message: 'Invalid token given' });
                return;
            }

            if (reg[0].acepted !== undefined && reg[0].acepted === false) {
                callback({ code: 400, message: 'The invitation is canceled, you can\'t do any modification' });
                return;
            }

            const booking = await fn.table('Booking', reg[0].idBooking).promise();
            if (moment(booking[0].bookingDate, dateFormat).diff(moment().add(10, 'minutes')) < 0) {
                callback({ code: 500, message: 'You can\'t do this operation at this moment' });
                return;
            }
        } catch (err) {
            console.error(err);
            callback(err);
            return;
        }

        const oldAcepted = reg[0].acepted;
        const oldModificationDate = reg[0].modificationDate;

        try {
            reg[0].acepted = response;
            reg[0].modificationDate = moment().format(dateFormat);

            await fn.insert('InvitedGuest', reg[0]).promise();
        } catch (err) {
            console.error(err);
            callback(err);
            return;
        }

        try {
            const orders = await fn.table('Order').where('idInvitedGuest', reg[0].id).promise();

            if (orders.length > 0) {
                await fn.delete('Order', orders.map((elem: any) => elem.id));
            }
        } catch (err) {
            console.error(err);
            callback(err);
            reg[0].acepted = oldAcepted;
            reg[0].modificationDate = oldModificationDate;
            fn.insert('InvitedGuest', reg[0]).promise();
            return;
        }

        callback(null);
    },
};

async function getFreeTable(date: string, assistants: number) {
    let [tables, booking] = await Promise.all([fn.table('Table').orderBy('seatsNumber').promise(),
    fn.table('Booking').filter((elem: dbtypes.IBooking) => {
        const bookDate = moment(elem.bookingDate, dateFormat);
        return moment(date, dateFormat).isBetween(bookDate, bookDate.add(bookingExpiration, bookingExpirationH), 'date', '[]');
    }).map((elem: dbtypes.IBooking) => elem.table || '-1').promise()]);

    console.log(booking);

    tables = tables.filter((elem: dbtypes.ITable) => {
        return !booking.includes(elem.id) && elem.seatsNumber >= assistants;
    });

    if (tables.length > 0) {
        return tables[0].id;
    }

    return 'error';
}

function dishToDishview() {
    return (element: any) => {
        element.id = Number(element.id);
        // TODO: get fav & likes
        element.favourite = {
            isFav: false,
            likes: 20,
        };

        element.extras.forEach((element2: any) => {
            delete (element2.description);
            element2.selected = false;
            return element2;
        });

        return element;
    };
}

async function calculateVATandOrderName(order: types.IOrderView): Promise<[number, string[]]> {
    let sum: number = 0;
    const names: string[] = [];

    const [dishes, extras] = await Promise.all([
        fn.table('Dish', order.lines.map((elem: types.IOrderLineView) => {
            return elem.idDish.toString();
        })).
            reduce((acum: any, elem: any) => {
                acum[elem.id] = elem;
                return acum;
            }, {}).
            promise(),
        fn.table('Ingredient').
            reduce((acum: any, elem: any) => {
                acum[elem.id] = elem;
                return acum;
            }, {}).
            promise(),
    ]);

    order.lines.forEach((elem: types.IOrderLineView) => {
        let x = dishes[elem.idDish.toString()].price;
        let name = '<span style="color: #317d35">' + elem.amount + '</span> ' + dishes[elem.idDish.toString()].name + ' with ';
        elem.extras.forEach((elem2: number) => {
            x += extras[elem2.toString()].price;
            name += extras[elem2.toString()].name + ', ';
        });

        sum += x * elem.amount;
        name = name.substring(0, name.length - 2);
        name += ' (' + x + '€)';

        names.push(name);
    });

    return [sum, names];
}

/**
 * Check all params of FilterView and put the correct values if neccesary
 *
 * @param {types.IFilterView} filter
 * @returns
 */
function checkFilter(filter: types.IFilterView) {
    filter.maxPrice = filter.maxPrice || 50;
    filter.minLikes = filter.minLikes || 0;
    filter.searchBy = filter.searchBy || '';
    filter.isFab = filter.isFab || false;
    filter.categories = filter.categories || [];
}