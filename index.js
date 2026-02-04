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

// --- KIBŐVÍTETT FORRÁSOK ---
const MANIFEST_SOURCES = [
    { name: 'ManifestHub (Primary)', url: (id) => `https://codeload.github.com/SteamAutoCracks/ManifestHub/zip/refs/heads/${id}` },
    { name: 'ManifestHub (Mirror)', url: (id) => `https://codeload.github.com/Steam-Manifests/ManifestHub/zip/refs/heads/${id}` },
    { name: 'Pointy-Hat Store', url: (id) => `https://codeload.github.com/Pointy-Hat/ManifestHub/zip/refs/heads/${id}` },
    { name: 'Steam-Archive', url: (id) => `https://codeload.github.com/Steam-Manifests-Archive/ManifestHub/zip/refs/heads/${id}` },
    { name: 'Depot-Mirror', url: (id) => `https://codeload.github.com/Manifest-Database/ManifestHub/zip/refs/heads/${id}` }
];

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent 
    ] 
});

// --- PARANCSOK REGISZTRÁLÁSA ---
const commands = [
    new SlashCommandBuilder()
        .setName('manifest')
        .setDescription('Steam manifest letöltése')
        .addSubcommand(sub => 
            sub.setName('id')
                .setDescription('Letöltés AppID alapján')
                .addStringOption(o => o.setName('appid').setDescription('Játék ID').setRequired(true))
                .addBooleanOption(o => o.setName('dlc').setDescription('DLC-k keresése is?')))
        .addSubcommand(sub => 
            sub.setName('nev')
                .setDescription('Keresés név alapján')
                .addStringOption(o => o.setName('jateknev').setDescription('Játék neve').setRequired(true).setAutocomplete(true))
                .addBooleanOption(o => o.setName('dlc').setDescription('DLC-k keresése is?'))),
    
    new SlashCommandBuilder()
        .setName('manage')
        .setDescription('Adminisztráció')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommandGroup(group =>
            group.setName('user')
                .setDescription('Felhasználók')
                .addSubcommand(sub => sub.setName('add').setDescription('Hozzáadás').addUserOption(o => o.setName('target').setRequired(true)))
                .addSubcommand(sub => sub.setName('remove').setDescription('Eltávolítás').addUserOption(o => o.setName('target').setRequired(true)))
                .addSubcommand(sub => sub.setName('list').setDescription('Lista')))
        .addSubcommandGroup(group =>
            group.setName('channel')
                .setDescription('Csatornák')
                .addSubcommand(sub => sub.setName('add').setDescription('Engedélyezés').addChannelOption(o => o.setName('channel').setRequired(true)))
                .addSubcommand(sub => sub.setName('remove').setDescription('Tiltás').addChannelOption(o => o.setName('channel').setRequired(true))))
].map(c => c.toJSON());

// --- SEGÉDFÜGGVÉNYEK ---

async function sendLog(title, description, color = 0x3b82f6) {
    const logChannel = await client.channels.fetch(process.env.LOG_CHANNEL_ID).catch(() => null);
    if (logChannel) {
        const embed = new EmbedBuilder().setTitle(title).setDescription(description).setColor(color).setTimestamp();
        logChannel.send({ embeds: [embed] });
    }
}

async function getManifestWithFallback(id) {
    for (const source of MANIFEST_SOURCES) {
        try {
            const res = await axios({ method: 'get', url: source.url(id), responseType: 'arraybuffer', timeout: 4000 });
            if (res.status === 200) return { data: res.data, source: source.name };
        } catch (e) { continue; }
    }
    return null;
}

// --- ESEMÉNYEK ---

client.once('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log(`✅ ${client.user.tag} online!`);
});

// Üzenet szűrő
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    let db = await Settings.findOne();
    if (!db || !db.allowedChannels.includes(message.channel.id)) return;
    if (message.author.id !== process.env.ADMIN_ID) {
        await message.delete().catch(() => {});
    }
});

// Autocomplete
client.on('interactionCreate', async interaction => {
    if (!interaction.isAutocomplete()) return;
    const focusedValue = interaction.options.getFocused();
    const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(focusedValue)}&l=hungarian&cc=HU`;
    const res = await axios.get(url).catch(() => ({ data: { items: [] } }));
    const suggestions = res.data.items.map(g => ({ name: `${g.name} (${g.id})`, value: g.id.toString() })).slice(0, 20);
    await interaction.respond(suggestions);
});

// Parancs kezelő
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    let db = await Settings.findOne() || await Settings.create({ allowedUsers: [process.env.ADMIN_ID], allowedChannels: [] });

    // ADMIN RÉSZ
    if (interaction.commandName === 'manage') {
        if (interaction.user.id !== process.env.ADMIN_ID) return interaction.reply({ content: 'Nincs jogod!', ephemeral: true });
        const group = interaction.options.getSubcommandGroup();
        const sub = interaction.options.getSubcommand();
        const target = interaction.options.getMember('target') || interaction.options.getChannel('channel');

        if (group === 'user') {
            if (sub === 'add') db.allowedUsers.push(target.id);
            if (sub === 'remove') db.allowedUsers = db.allowedUsers.filter(id => id !== target.id);
            if (sub === 'list') return interaction.reply({ content: `Tagok: ${db.allowedUsers.map(id => `<@${id}>`).join(', ')}`, ephemeral: true });
        }
        if (group === 'channel') {
            if (sub === 'add') db.allowedChannels.push(target.id);
            if (sub === 'remove') db.allowedChannels = db.allowedChannels.filter(id => id !== target.id);
        }
        await db.save();
        return interaction.reply({ content: 'Beállítások mentve!', ephemeral: true });
    }

    // MANIFEST RÉSZ
    if (interaction.commandName === 'manifest') {
        if (db.allowedChannels.length > 0 && !db.allowedChannels.includes(interaction.channelId)) return interaction.reply({ content: 'Itt nem használhatod!', ephemeral: true });
        if (!db.allowedUsers.includes(interaction.user.id)) return interaction.reply({ content: 'Nincs engedélyed!', ephemeral: true });

        const appId = interaction.options.getSubcommand() === 'id' ? interaction.options.getString('appid') : interaction.options.getString('jateknev');
        const includeDlc = interaction.options.getBoolean('dlc') || false;

        await interaction.deferReply({ ephemeral: true });

        let results = [];
        let files = [];

        // Alapjáték
        const main = await getManifestWithFallback(appId);
        if (main) {
            files.push(new AttachmentBuilder(Buffer.from(main.data), { name: `base_${appId}.zip` }));
            results.push(`✅ **Alapjáték (${appId})** - [${main.source}]`);
        } else {
            results.push(`❌ **Alapjáték (${appId})** - Nem található.`);
        }

        // DLC-k
        if (includeDlc) {
            results.push(`\n**DLC-k keresése...**`);
            const dlcData = await axios.get(`https://store.steampowered.com/api/appdetails?appids=${appId}`).catch(() => null);
            const dlcs = dlcData?.data[appId]?.data?.dlc || [];

            for (const dlcId of dlcs.slice(0, 9)) { // Discord limit: max 10 fájl összesen
                const dlcFile = await getManifestWithFallback(dlcId);
                if (dlcFile) {
                    files.push(new AttachmentBuilder(Buffer.from(dlcFile.data), { name: `dlc_${dlcId}.zip` }));
                    results.push(`🔹 DLC (${dlcId}) - ✅`);
                }
            }
        }

        if (files.length === 0) return interaction.editReply('Nem találtam semmit.');

        const embed = new EmbedBuilder()
            .setTitle('📦 Steam Manifest Tool')
            .setColor(0x00aeef)
            .setDescription(results.join('\n'))
            .setFooter({ text: 'Használd a Steam Tools-szal!' });

        await interaction.editReply({ embeds: [embed], files: files });
        await sendLog('📥 Letöltés', `Felhasználó: ${interaction.user.tag}\nJáték ID: ${appId}`);
    }
});

client.login(process.env.DISCORD_TOKEN);
