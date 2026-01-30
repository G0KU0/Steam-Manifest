require('dotenv').config();
const { 
    Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, 
    AttachmentBuilder, REST, Routes, PermissionFlagsBits, 
    ActionRowBuilder, ButtonBuilder, ButtonStyle 
} = require('discord.js');
const axios = require('axios');
const mongoose = require('mongoose');
const express = require('express');

// --- RENDER.COM PORT FIGYELÉS ---
const app = express();
app.get('/', (req, res) => res.send('Manifest Bot is online!'));
app.listen(process.env.PORT || 3000);

// --- MONGODB KAPCSOLAT ÉS SÉMA ---
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('Sikeres MongoDB csatlakozás'))
    .catch(err => console.error('MongoDB hiba:', err));

const SettingsSchema = new mongoose.Schema({
    allowedUsers: [String],
    allowedChannels: [String]
});
const Settings = mongoose.model('Settings', SettingsSchema);

// --- SLASH PARANCSOK ---
const commands = [
    new SlashCommandBuilder()
        .setName('manifest')
        .setDescription('Steam manifest letöltése')
        .addSubcommand(sub => 
            sub.setName('id')
                .setDescription('Letöltés pontos AppID alapján')
                .addStringOption(opt => opt.setName('appid').setDescription('A játék ID-ja').setRequired(true)))
        .addSubcommand(sub => 
            sub.setName('nev')
                .setDescription('Keresés és letöltés név alapján')
                .addStringOption(opt => opt.setName('jateknev').setDescription('Kezdd el írni a nevet...').setRequired(true).setAutocomplete(true))),

    new SlashBuilder()
        .setName('manage')
        .setDescription('Bot adminisztráció')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommandGroup(group =>
            group.setName('user')
                .setDescription('Felhasználók kezelése')
                .addSubcommand(sub => sub.setName('add').setDescription('Hozzáadás').addUserOption(o => o.setName('target').setRequired(true).setDescription('Felhasználó')))
                .addSubcommand(sub => sub.setName('remove').setDescription('Eltávolítás').addUserOption(o => o.setName('target').setRequired(true).setDescription('Felhasználó')))
                .addSubcommand(sub => sub.setName('list').setDescription('Lista megtekintése')))
        .addSubcommandGroup(group =>
            group.setName('channel')
                .setDescription('Csatornák kezelése')
                .addSubcommand(sub => sub.setName('add').setDescription('Csatorna engedélyezése').addChannelOption(o => o.setName('channel').setRequired(true).setDescription('Csatorna')))
                .addSubcommand(sub => sub.setName('remove').setDescription('Csatorna tiltása').addChannelOption(o => o.setName('channel').setRequired(true).setDescription('Csatorna'))))
].map(c => c.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// --- LOGOLÁS FUNKCIÓ ---
async function sendLog(title, description, color = 0x3b82f6) {
    const logChannel = await client.channels.fetch(process.env.LOG_CHANNEL_ID).catch(() => null);
    if (!logChannel) return;
    const logEmbed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(color)
        .setTimestamp();
    logChannel.send({ embeds: [logEmbed] });
}

// --- READY ESEMÉNY ---
client.once('ready', async () => {
    console.log(`Bejelentkezve: ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('Parancsok frissítve!');
    } catch (e) { console.error(e); }
});

// --- AUTOCOMPLETE (MÁR 1 BETŰTŐL) ---
client.on('interactionCreate', async interaction => {
    if (!interaction.isAutocomplete()) return;
    const focusedValue = interaction.options.getFocused();
    if (focusedValue.length === 0) return interaction.respond([]);

    try {
        const search = await axios.get(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(focusedValue)}&l=hungarian&cc=HU`);
        const suggestions = search.data.items
            .map(g => ({ name: `${g.name.substring(0, 80)} (ID: ${g.id})`, value: g.id.toString() }))
            .slice(0, 15);
        await interaction.respond(suggestions);
    } catch (e) { await interaction.respond([]); }
});

// --- PARANCSKEZELÉS ---
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    let db = await Settings.findOne();
    if (!db) db = await Settings.create({ allowedUsers: [process.env.ADMIN_ID], allowedChannels: [] });

    // ADMIN KEZELÉS
    if (interaction.commandName === 'manage') {
        if (interaction.user.id !== process.env.ADMIN_ID) return interaction.reply({ content: '❌ Csak a bot tulajdonosa használhatja!', ephemeral: true });

        const group = interaction.options.getSubcommandGroup();
        const sub = interaction.options.getSubcommand();

        if (group === 'user') {
            const target = interaction.options.getUser('target');
            if (sub === 'add') {
                if (!db.allowedUsers.includes(target.id)) db.allowedUsers.push(target.id);
                await sendLog('👤 Admin: Felhasználó hozzáadva', `Hozzáadva: ${target.tag} (${target.id})`);
            } else if (sub === 'remove') {
                db.allowedUsers = db.allowedUsers.filter(id => id !== target.id);
                await sendLog('👤 Admin: Felhasználó eltávolítva', `Eltávolítva: ${target.tag}`, 0xff0000);
            } else if (sub === 'list') {
                const list = db.allowedUsers.map(id => `<@${id}>`).join('\n') || 'Üres';
                return interaction.reply({ content: `**Engedélyezett felhasználók:**\n${list}`, ephemeral: true });
            }
        }

        if (group === 'channel') {
            const channel = interaction.options.getChannel('channel');
            if (sub === 'add') {
                if (!db.allowedChannels.includes(channel.id)) db.allowedChannels.push(channel.id);
                await sendLog('📺 Admin: Csatorna engedélyezve', `Csatorna: <#${channel.id}>`);
            } else if (sub === 'remove') {
                db.allowedChannels = db.allowedChannels.filter(id => id !== channel.id);
                await sendLog('📺 Admin: Csatorna tiltva', `Csatorna: <#${channel.id}>`, 0xff0000);
            }
        }

        await db.save();
        return interaction.reply({ content: '✅ Sikeresen mentve!', ephemeral: true });
    }

    // MANIFEST GENERÁLÁS
    if (interaction.commandName === 'manifest') {
        if (db.allowedChannels.length > 0 && !db.allowedChannels.includes(interaction.channelId)) {
            return interaction.reply({ content: '❌ Ebben a csatornában nem használhatod a botot!', ephemeral: true });
        }
        if (!db.allowedUsers.includes(interaction.user.id)) {
            return interaction.reply({ content: '❌ Nincs jogosultságod a generáláshoz!', ephemeral: true });
        }

        const appId = interaction.options.getSubcommand() === 'id' 
            ? interaction.options.getString('appid').trim() 
            : interaction.options.getString('jateknev');

        // AppID validáció
        if (!/^\d+$/.test(appId)) return interaction.reply({ content: '❌ Érvénytelen AppID!', ephemeral: true });

        await interaction.deferReply({ ephemeral: true });

        try {
            // Ellenőrzés és letöltés az eredeti források alapján
            const checkUrl = `https://api.github.com/repos/SteamAutoCracks/ManifestHub/branches/${appId}`;
            const downloadUrl = `https://codeload.github.com/SteamAutoCracks/ManifestHub/zip/refs/heads/${appId}`;

            await axios.get(checkUrl);
            const response = await axios({ method: 'get', url: downloadUrl, responseType: 'arraybuffer' });

            const attachment = new AttachmentBuilder(Buffer.from(response.data), { name: `manifest_${appId}.zip` });
            const embed = new EmbedBuilder()
                .setColor(0x3b82f6)
                .setTitle('STEAM MANIFEST HUB')
                .setDescription(`A(z) **${appId}** manifestje letöltve.\n\n**FIGYELEM:** Ez a fájl csak tájékoztató jellegű.`)
                .setFooter({ text: 'by Szaby | Manifest Database' });

            await interaction.editReply({ embeds: [embed], files: [attachment] });
            await sendLog('📥 Manifest Letöltve', `**Ki:** ${interaction.user.tag}\n**AppID:** ${appId}\n**Csatorna:** <#${interaction.channelId}>`);

        } catch (e) {
            await interaction.editReply('❌ Manifest nem található az adatbázisban.');
        }
    }
});

client.login(process.env.DISCORD_TOKEN);

// Helper a Slash Command építéshez
function SlashBuilder() { return new SlashCommandBuilder(); }
