require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, REST, Routes, PermissionFlagsBits } = require('discord.js');
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

// --- PARANCSOK DEFINIÁLÁSA ---
const commands = [
    // Manifest letöltő parancs
    new SlashCommandBuilder()
        .setName('manifest')
        .setDescription('Steam manifest letöltése (Csak engedélyezett felhasználóknak)')
        .addSubcommand(sub => 
            sub.setName('id')
                .setDescription('Letöltés AppID alapján')
                .addStringOption(opt => opt.setName('appid').setRequired(true).setDescription('A játék ID-ja')))
        .addSubcommand(sub => 
            sub.setName('nev')
                .setDescription('Keresés név alapján')
                .addStringOption(opt => opt.setName('jateknev').setRequired(true).setAutocomplete(true).setDescription('Játék neve'))),
    
    // Kezelő parancsok (Adminoknak)
    new SlashCommandBuilder()
        .setName('manage')
        .setDescription('Bot kezelése')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        // Felhasználók kezelése
        .addSubcommandGroup(group =>
            group.setName('user')
                .setDescription('Felhasználók kezelése')
                .addSubcommand(sub => sub.setName('add').setDescription('Felhasználó hozzáadása').addUserOption(o => o.setName('target').setRequired(true).setDescription('A felhasználó')))
                .addSubcommand(sub => sub.setName('remove').setDescription('Felhasználó eltávolítása').addUserOption(o => o.setName('target').setRequired(true).setDescription('A felhasználó')))
                .addSubcommand(sub => sub.setName('list').setDescription('Engedélyezett felhasználók listája')))
        // Csatornák kezelése
        .addSubcommandGroup(group =>
            group.setName('channel')
                .setDescription('Csatornák kezelése')
                .addSubcommand(sub => sub.setName('add').setDescription('Csatorna engedélyezése').addChannelOption(o => o.setName('channel').setRequired(true).setDescription('A csatorna')))
                .addSubcommand(sub => sub.setName('remove').setDescription('Csatorna tiltása').addChannelOption(o => o.setName('channel').setRequired(true).setDescription('A csatorna'))))
].map(c => c.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// --- SEGÉDFÜGGVÉNY: LOGOLÁS ---
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

// --- BOT INDÍTÁSA ---
client.once('ready', async () => {
    console.log(`Bot kész: ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
});

// --- AUTOMATIKUS KIEGÉSZÍTÉS ---
client.on('interactionCreate', async interaction => {
    if (!interaction.isAutocomplete()) return;
    const focusedValue = interaction.options.getFocused();
    if (focusedValue.length < 2) return interaction.respond([]);
    try {
        const search = await axios.get(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(focusedValue)}&l=hungarian`);
        await interaction.respond(search.data.items.slice(0, 10).map(g => ({ name: `${g.name} (ID: ${g.id})`, value: g.id.toString() })));
    } catch (e) { await interaction.respond([]); }
});

// --- PARANCSKEZELŐ ---
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    let db = await Settings.findOne() || await Settings.create({ allowedUsers: [process.env.ADMIN_ID], allowedChannels: [] });

    // 1. ADMIN PARANCSOK (manage)
    if (interaction.commandName === 'manage') {
        if (interaction.user.id !== process.env.ADMIN_ID && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: '❌ Nincs jogosultságod ehhez!', ephemeral: true });
        }

        const group = interaction.options.getSubcommandGroup();
        const sub = interaction.options.getSubcommand();

        if (group === 'user') {
            const target = interaction.options.getUser('target');
            if (sub === 'add') {
                if (!db.allowedUsers.includes(target.id)) db.allowedUsers.push(target.id);
                await sendLog('👤 Felhasználó Hozzáadva', `${interaction.user.tag} hozzáadta: ${target.tag}`);
            } else if (sub === 'remove') {
                db.allowedUsers = db.allowedUsers.filter(id => id !== target.id);
                await sendLog('👤 Felhasználó Eltávolítva', `${interaction.user.tag} eltávolította: ${target.tag}`, 0xff0000);
            } else if (sub === 'list') {
                return interaction.reply({ content: `📜 **Engedélyezett tagok:**\n${db.allowedUsers.map(id => `<@${id}>`).join('\n') || 'Nincs senki.'}`, ephemeral: true });
            }
        }

        if (group === 'channel') {
            const channel = interaction.options.getChannel('channel');
            if (sub === 'add') {
                if (!db.allowedChannels.includes(channel.id)) db.allowedChannels.push(channel.id);
                await sendLog('📺 Csatorna Hozzáadva', `${interaction.user.tag} engedélyezte: <#${channel.id}>`);
            } else if (sub === 'remove') {
                db.allowedChannels = db.allowedChannels.filter(id => id !== channel.id);
                await sendLog('📺 Csatorna Eltávolítva', `${interaction.user.tag} tiltotta: <#${channel.id}>`, 0xff0000);
            }
        }

        await db.save();
        return interaction.reply({ content: '✅ Beállítások frissítve!', ephemeral: true });
    }

    // 2. MANIFEST PARANCS
    if (interaction.commandName === 'manifest') {
        // Ellenőrzés: Csatorna és Felhasználó
        if (db.allowedChannels.length > 0 && !db.allowedChannels.includes(interaction.channelId)) {
            return interaction.reply({ content: '❌ Ebben a csatornában nem használhatod a botot!', ephemeral: true });
        }
        if (!db.allowedUsers.includes(interaction.user.id)) {
            return interaction.reply({ content: '❌ Nincs jogosultságod a parancshoz! Kérj engedélyt egy admintól.', ephemeral: true });
        }

        const appId = interaction.options.getSubcommand() === 'id' ? interaction.options.getString('appid') : interaction.options.getString('jateknev');
        
        // Validáció: csak számok
        if (!/^\d+$/.test(appId)) return interaction.reply({ content: '❌ Érvénytelen AppID!', ephemeral: true });

        await interaction.deferReply({ ephemeral: true }); // CSAK Ő LÁSSA

        try {
            const checkUrl = `https://api.github.com/repos/SteamAutoCracks/ManifestHub/branches/${appId}`; //
            const downloadUrl = `https://codeload.github.com/SteamAutoCracks/ManifestHub/zip/refs/heads/${appId}`; //

            await axios.get(checkUrl);
            const response = await axios({ method: 'get', url: downloadUrl, responseType: 'arraybuffer' });
            
            const attachment = new AttachmentBuilder(Buffer.from(response.data), { name: `manifest_${appId}.zip` });
            const embed = new EmbedBuilder()
                .setColor(0x3b82f6)
                .setTitle('STEAM MANIFEST HUB')
                .setDescription(`A(z) **${appId}** manifestje letöltve.\n\n**DISCLAIMER:** Ez a szoftver csak tájékoztató jellegű.`)
                .setFooter({ text: 'by Szaby | Manifest Database' });

            await interaction.editReply({ embeds: [embed], files: [attachment] });
            await sendLog('📥 Manifest Generálva', `**Felhasználó:** ${interaction.user.tag}\n**AppID:** ${appId}\n**Csatorna:** <#${interaction.channelId}>`);

        } catch (e) {
            await interaction.editReply('❌ Manifest nem található az adatbázisban.');
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
