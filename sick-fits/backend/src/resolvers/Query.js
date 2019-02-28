const {forwardTo} = require('prisma-binding');

const {hasPermission} = require('../utils');

const Query = {
    items: forwardTo('db'),
    // async items(parent, args, ctx, info) {
    //     const items = await ctx.db.query.items();
    //     return items;
    // }
    item: forwardTo('db'),
    itemsConnection: forwardTo('db'),
    currentUser(parent, args, ctx, info) {
        // check if there is a current userId
        if (!ctx.request.userId) {
            return null;
        }
        return ctx.db.query.user({
            where: {id: ctx.request.userId}
        }, info);
    },
    async users(parent, args, ctx, info) {
        // Check id they are logged in
        if (!ctx.request.userId) {
            throw new Error(`You must be logged in`);
        }
        // Check if the user has permissions to query all the users
        hasPermission(ctx.request.user, ['ADMIN', 'PERMISSIONUPDATE']);
        // Id they do, query all the users
        return ctx.db.query.users({}, info);
    }
};

module.exports = Query;
