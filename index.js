require('dotenv').config();
const { 
    Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, 
    AttachmentBuilder, REST, Routes, PermissionFlagsBits
} = require('discord.js');
const axios = require('axios');
const mongoose = require('mongoose');
const express = require('express');

// --- RENDER.COM ÉLETBEN TARTÁS ---
const app = express();
app.get('/', (req, res) => res.send('Manifest Bot is online!'));
app.listen(process.env.PORT || 3000);

// --- MONGODB ADATMODELL ---
mongoose.connect(process.env.MONGODB_URI);
const Settings = mongoose.model('Settings', new mongoose.Schema({
    allowedUsers: [String],
    allowedChannels: [String]
}));

// --- BOT INICIALIZÁLÁSA ---
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent 
    ] 
});

// --- SLASH PARANCSOK REGISZTRÁLÁSA ---
const commands = [
    new SlashCommandBuilder()
        .setName('manifest')
        .setDescription('Steam manifest letöltése')
        .addSubcommand(sub => 
            sub.setName('id')
                .setDescription('Letöltés pontos AppID alapján')
                .addStringOption(opt => opt.setName('appid').setDescription('A játék pontos ID-ja').setRequired(true)))
        .addSubcommand(sub => 
            sub.setName('nev')
                .setDescription('Keresés név alapján')
                .addStringOption(opt => opt.setName('jateknev').setDescription('Kezdd el gépelni a játék nevét').setRequired(true).setAutocomplete(true))),
    
    new SlashCommandBuilder()
        .setName('manage')
        .setDescription('Bot kezelése (Admin)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommandGroup(group =>
            group.setName('user')
                .setDescription('Felhasználók kezelése')
                .addSubcommand(sub => sub.setName('add').setDescription('Felhasználó hozzáadása').addUserOption(o => o.setName('target').setDescription('Felhasználó kiválasztása').setRequired(true)))
                .addSubcommand(sub => sub.setName('remove').setDescription('Felhasználó eltávolítása').addUserOption(o => o.setName('target').setDescription('Felhasználó kiválasztása').setRequired(true)))
                .addSubcommand(sub => sub.setName('list').setDescription('Engedélyezett felhasználók listája')))
        .addSubcommandGroup(group =>
            group.setName('channel')
                .setDescription('Csatornák kezelése')
                .addSubcommand(sub => sub.setName('add').setDescription('Csatorna engedélyezése').addChannelOption(o => o.setName('channel').setDescription('Csatorna kiválasztása').setRequired(true)))
                .addSubcommand(sub => sub.setName('remove').setDescription('Csatorna tiltása').addChannelOption(o => o.setName('channel').setDescription('Csatorna kiválasztása').setRequired(true))))
].map(c => c.toJSON());

client.once('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log(`Bot kész: ${client.user.tag}`);
    } catch (e) { console.error(e); }
});

// --- LOGOLÁS ---
async function sendLog(title, description, color = 0x3b82f6) {
    const logChannel = await client.channels.fetch(process.env.LOG_CHANNEL_ID).catch(() => null);
    if (logChannel) {
        const embed = new EmbedBuilder().setTitle(title).setDescription(description).setColor(color).setTimestamp();
        logChannel.send({ embeds: [embed] });
    }
}

// --- ÜZENET SZŰRŐ ÉS SEGÍTSÉG ---
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    let db = await Settings.findOne();
    if (!db || !db.allowedChannels.includes(message.channel.id)) return;

    // Ha nem az admin ír szöveges üzenetet
    if (message.author.id !== process.env.ADMIN_ID) {
        try {
            await message.delete();
            
            let response = `❌ <@${message.author.id}>, ebben a szobában csak parancsokat használhatsz!\n\n`;
            
            if (db.allowedUsers.includes(message.author.id)) {
                response += `**Mivel van engedélyed, ezeket a parancsokat használhatod:**\n> \`/manifest id\` - Letöltés AppID-val\n> \`/manifest nev\` - Keresés név alapján`;
            } else {
                response += `⚠️ Neked jelenleg **nincs engedélyed** a parancsok használatához. Kérj hozzáférést egy admintól!`;
            }

            const reply = await message.channel.send(response);
            setTimeout(() => reply.delete().catch(() => {}), 10000); // 10 mp után törli
        } catch (e) { console.error(e); }
    }
});

// --- JAVÍTOTT AUTOCOMPLETE (NÉV SZERINTI KERESÉS) ---
client.on('interactionCreate', async interaction => {
    if (!interaction.isAutocomplete()) return;

    if (interaction.commandName === 'manifest') {
        const focusedValue = interaction.options.getFocused();
        if (!focusedValue) return interaction.respond([]);

        try {
            // Steam kereső API (cc=HU a magyar találatokért)
            const search = await axios.get(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(focusedValue)}&l=hungarian&cc=HU`, { timeout: 2500 });
            
            if (!search.data || !search.data.items) return interaction.respond([]);

            const suggestions = search.data.items
                .map(g => ({ 
                    name: `${g.name.substring(0, 85)} (ID: ${g.id})`, 
                    value: g.id.toString() 
                }))
                .slice(0, 20);

            await interaction.respond(suggestions);
        } catch (e) {
            // Ha hiba van vagy lassú az API, üres választ küldünk a crash elkerülésére
            await interaction.respond([]).catch(() => {});
        }
    }
});

// --- PARANCSKEZELŐ ---
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    let db = await Settings.findOne() || await Settings.create({ allowedUsers: [process.env.ADMIN_ID], allowedChannels: [] });

    if (interaction.commandName === 'manage') {
        if (interaction.user.id !== process.env.ADMIN_ID) return interaction.reply({ content: '❌ Nincs jogosultságod!', ephemeral: true });

        const group = interaction.options.getSubcommandGroup();
        const sub = interaction.options.getSubcommand();

        if (group === 'user') {
            const target = interaction.options.getUser('target');
            if (sub === 'add') {
                if (!db.allowedUsers.includes(target.id)) db.allowedUsers.push(target.id);
            } else if (sub === 'remove') {
                db.allowedUsers = db.allowedUsers.filter(id => id !== target.id);
            } else if (sub === 'list') {
                return interaction.reply({ content: `**Engedélyezett felhasználók:**\n${db.allowedUsers.map(id => `<@${id}>`).join('\n') || 'Nincs senki.'}`, ephemeral: true });
            }
        }

        if (group === 'channel') {
            const channel = interaction.options.getChannel('channel');
            if (sub === 'add') {
                if (!db.allowedChannels.includes(channel.id)) db.allowedChannels.push(channel.id);
            } else if (sub === 'remove') {
                db.allowedChannels = db.allowedChannels.filter(id => id !== channel.id);
            }
        }
        await db.save();
        return interaction.reply({ content: '✅ Beállítások frissítve!', ephemeral: true });
    }

    if (interaction.commandName === 'manifest') {
        if (db.allowedChannels.length > 0 && !db.allowedChannels.includes(interaction.channelId)) {
            return interaction.reply({ content: '❌ Ebben a csatornában nem használhatod a botot!', ephemeral: true });
        }
        if (!db.allowedUsers.includes(interaction.user.id)) {
            return interaction.reply({ content: '❌ Nincs jogosultságod a generáláshoz!', ephemeral: true });
        }

        const appId = interaction.options.getSubcommand() === 'id' ? interaction.options.getString('appid') : interaction.options.getString('jateknev');
        if (!/^\d+$/.test(appId)) return interaction.reply({ content: '❌ Érvénytelen AppID!', ephemeral: true });

        await interaction.deferReply({ ephemeral: true });

        try {
            const checkUrl = `https://api.github.com/repos/SteamAutoCracks/ManifestHub/branches/${appId}`;
            const downloadUrl = `https://codeload.github.com/SteamAutoCracks/ManifestHub/zip/refs/heads/${appId}`;

            await axios.get(checkUrl);
            const response = await axios({ method: 'get', url: downloadUrl, responseType: 'arraybuffer' });
            
            const attachment = new AttachmentBuilder(Buffer.from(response.data), { name: `manifest_${appId}.zip` });
            const embed = new EmbedBuilder()
                .setColor(0x3b82f6)
                .setTitle('STEAM MANIFEST HUB')
                .setDescription(`A(z) **${appId}** manifestje letöltve.\n\n**DISCLAIMER:** Ez a szoftver csak tájékoztató jellegű.`)
                .setFooter({ text: 'by Szaby | Manifest Database' });

            await interaction.editReply({ embeds: [embed], files: [attachment] });
            await sendLog('📥 Manifest Letöltve', `**Ki:** ${interaction.user.tag}\n**AppID:** ${appId}\n**Csatorna:** <#${interaction.channelId}>`);

        } catch (e) {
            await interaction.editReply('❌ Manifest nem található az adatbázisban.');
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
