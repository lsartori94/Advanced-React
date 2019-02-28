const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {randomBytes} = require('crypto');
const {promisify} = require('util');

const {transport, makeANiceEmail} = require('../mail');
const {hasPermission} = require('../utils');

const Mutations = {
    async createItem(parent, args, ctx, info) {
        if (!ctx.request.userId) {
            throw new Error(`You must be logged in to do that!`);
        }

        const item = await ctx.db.mutation.createItem({
            data: {
                user: {
                    // This is how we create a relationship between item and user
                    connect: {
                        id: ctx.request.userId
                    }
                },
                ...args
            }
        }, info);

        return item;
    },
    updateItem(parent, args, ctx, info) {
        // Take a copy of the updates
        const updates = {...args};
        // Remove the ID from updates
        delete updates.id;
        // Run the update method
        return ctx.db.mutation.updateItem(
            {
                data: updates,
                where: {
                    id: args.id
                }
            },
            info
        );
    },
    async deleteItem(parent, args, ctx, info) {
        const where = {id: args.id};
        // 1 Find Item
        const item = await ctx.db.query.item({where}, `{id title user {id}}`);
        // 2 Check if they own the item or have permissions
        const ownsItem = item.user.id === ctx.request.userId;
        const hasPermissions = ctx.request.user.permissions.some(permission => ['ADMIN', 'ITEMDELETE'].includes(permission));

        if (!ownsItem && !hasPermissions) {
            throw new Error(`You don't have permissions to do that!`);
        }
        // 3 Delete item
        return ctx.db.mutation.deleteItem({where}, info);
    },
    async signup(parent, args, ctx, info) {
        // lowercase email
        args.email = args.email.toLowerCase();
        // Hash the password
        const password = await bcrypt.hash(args.password, 10);
        // create the user
        const user = await ctx.db.mutation.createUser({
            data: {
                ...args,
                password: password,
                permissions: { set: ['USER'] },
            }
        }, info);
        // create JWT token
        const token = jwt.sign({userId: user.id}, process.env.APP_SECRET);
        // set JWT as a cookie on the response
        ctx.response.cookie('token', token, {
            httpOnly: true,
            maxAge: 1000 * 60 * 60 * 24 * 365, // 1 year cookie
        });
        // return the user to the browser
        return user;
    },
    async signin(parent, {email, password}, ctx, info) {
        // check if there is a user with that email
        const user = await ctx.db.query.user({where: {email}});
        if (!user) {
            throw new Error(`No such user found for email ${email}`);
        }
        // check if the password is correct
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) {
            throw new Error(`Invalid Password`);
        }
        // generate JWT
        const token = jwt.sign({userId: user.id}, process.env.APP_SECRET);
        // set the cookie with the token
        ctx.response.cookie('token', token, {
            httpOnly: true,
            maxAge: 1000 * 60 * 60 * 24 * 365, // 1 year cookie
        });
        // return user
        return user;
    },
    signout(parent, args, ctx, info) {
        ctx.response.clearCookie('token');
        return {message: 'Loogout Successful'};
    },
    async requestReset(parent, args, ctx, info) {
        // Check if the user is real
        const user = await ctx.db.query.user({where: {email: args.email}});
        if (!user) {
            throw new Error(`No such user found for email ${args.email}`);
        }
        // Set reset token and expiry on the user
        const randomBytesPromisefied = promisify(randomBytes);
        const resetToken = (await randomBytesPromisefied(20)).toString('hex');
        const resetTokenExpiry = Date.now() + 3600000; // 1 hour from now
        const res = await ctx.db.mutation.updateUser({
            where: {email: args.email},
            data: {resetToken, resetTokenExpiry}
        });
        // Email the reset token
        const mailRes = await transport.sendMail({
            from: 'test@test.com',
            to: user.email,
            subject: 'Your Password Reset Token',
            html: makeANiceEmail(
                `Your Password Reset Token is here!
                \n\n
                <a href="${process.env.FRONTEND_URL}/reset?resetToken=${resetToken}">Click Here to Reset</a>`),
        });
        // Return the message
        return {message: 'Password Reset Successful'};
    },
    async resetPassword(parent, args, ctx, info) {
        // Check if the passwords match
        if (args.password !== args.confirmedPassword) {
            throw new Error(`Your Passwords don't match`);
        }
        // Check if its a legit reset token
        // Check if its expired
        const [user] = await ctx.db.query.users({
            where: {
                resetToken: args.resetToken,
                resetTokenExpiry_gte: Date.now() - 3600000
            }
        });
        if (!user) {
            throw new Error(`This token is either invalid or expired`);
        }
        // Hash new password
        const password = await bcrypt.hash(args.password, 10);
        // Save new password to user and remove reset token fields
        const updatedUser = await ctx.db.mutation.updateUser({
            where: {
                email: user.email
            },
            data: {
                password,
                resetToken: null,
                resetTokenExpiry: null
            }
        });
        // Generate JWT
        const token = jwt.sign({userId: updatedUser.id}, process.env.APP_SECRET);
        // Set JWT cookie
        ctx.response.cookie('token', token, {
            httpOnly: true,
            maxAge: 1000 * 60 * 60 * 24 * 365
        });
        // Return the new user
        return updatedUser;
    },
    async updatePermissions(parent, args, ctx, info) {
        // Check if they are logged in
        if (!ctx.request.userId) {
            throw new Error(`You must be logged in to do this`);
        }
        // Query the current user
        const currentUser = await ctx.db.query.user({
            where: {
                id: ctx.request.userId
            }
        }, info)
        // Check if they have permissions to do this
        hasPermission(currentUser, ['ADMIN', 'PERMISSIONUPDATE']);
        // Update permissions
        return ctx.db.mutation.updateUser({
            data: {
                permissions: {
                    set: args.permissions
                }
            },
            where: {
                id: args.userId
            }
        }, info);
    },
    async addToCart(parent, args, ctx, info) {
        // Make suer user is signed in
        const {userId} = ctx.request;
        if (!userId) {
            throw new Error(`You should be logged in for this`);
        }
        // query the users current cart
        const [existingCartItem] = await ctx.db.query.cartItems({
            where: {
                user: {id: userId},
                item: {id: args.id}
            }
        });
        // Check if the item is already in their cart
        if (existingCartItem) {
            // increment by 1 if it is
            return ctx.db.mutation.updateCartItem({
                where: {id: existingCartItem.id},
                data: {quantity: existingCartItem.quantity + 1}
            }, info);
        }
        // If not create a fresh cart item for that user
        return ctx.db.mutation.createCartItem({
            data: {
                user: {
                    connect: {id: userId}
                },
                item: {
                    connect: {id: args.id}
                }
            }
        }, info);
    }
};

module.exports = Mutations;
