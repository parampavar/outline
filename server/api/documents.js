import Router from 'koa-router';
import httpErrors from 'http-errors';
import {
  sequelize,
} from '../sequelize';

import auth from './authentication';
import pagination from './middlewares/pagination';
import { presentDocument } from '../presenters';
import { Document, Atlas } from '../models';

const router = new Router();

// FIXME: This really needs specs :/
router.post('documents.info', auth({ require: false }), async (ctx) => {
  let { id } = ctx.body;
  ctx.assertPresent(id, 'id is required');

  const document = await Document.findOne({
    where: {
      id,
    },
  });

  if (!document) throw httpErrors.NotFound();

  // Don't expose private documents outside the team
  if (document.private) {
    if (!ctx.state.user) throw httpErrors.NotFound();

    const user = await ctx.state.user;
    if (document.teamId !== user.teamId) {
      throw httpErrors.NotFound();
    }

    ctx.body = {
      data: await presentDocument(document, true),
    };
  } else {
    ctx.body = {
      data: await presentDocument(document),
    };
  }
});

router.post('documents.search', auth(), async (ctx) => {
  const { query } = ctx.body;
  ctx.assertPresent(query, 'query is required');

  const user = await ctx.state.user;

  const sql = `
  SELECT * FROM documents
  WHERE "searchVector" @@ plainto_tsquery('english', :query) AND
    "teamId" = '${user.teamId}'::uuid
  ORDER BY ts_rank(documents."searchVector", plainto_tsquery('english', :query))
  DESC;
  `;

  const documents = await sequelize
  .query(
    sql,
    {
      replacements: {
        query: query,
      },
      model: Document,
    }
  );

  let data = [];
  await Promise.all(documents.map(async (document) => {
    data.push(await presentDocument(document));
  }));

  ctx.body = {
    pagination: ctx.state.pagination,
    data,
  };
});


router.post('documents.create', auth(), async (ctx) => {
  const {
    collection,
    title,
    text,
    parentDocument,
  } = ctx.body;
  ctx.assertPresent(collection, 'collection is required');
  ctx.assertPresent(title, 'title is required');
  ctx.assertPresent(text, 'text is required');

  const user = ctx.state.user;
  const ownerAtlas = await Atlas.findOne({
    where: {
      id: collection,
      teamId: user.teamId,
    },
  });

  if (!ownerAtlas) throw httpErrors.BadRequest();

  let parentDocumentObj = {};
  if (parentDocument && ownerAtlas.type === 'atlas') {
    parentDocumentObj = await Document.findOne({
      where: {
        id: parentDocument,
        atlasId: ownerAtlas.id,
      },
    });
  }

  const document = await Document.create({
    parentDocumentId: parentDocumentObj.id,
    atlasId: ownerAtlas.id,
    teamId: user.teamId,
    userId: user.id,
    lastModifiedById: user.id,
    title,
    text,
  });
  await document.createRevision();

  // TODO: Move to afterSave hook if possible with imports
  if (parentDocument && ownerAtlas.type === 'atlas') {
    ownerAtlas.addNodeToNavigationTree(document);
    await ownerAtlas.save();
  }

  ctx.body = {
    data: await presentDocument(document, true),
  };
});

router.post('documents.update', auth(), async (ctx) => {
  const {
    id,
    title,
    text,
  } = ctx.body;
  ctx.assertPresent(id, 'id is required');
  ctx.assertPresent(title, 'title is required');
  ctx.assertPresent(text, 'text is required');

  const user = ctx.state.user;
  const document = await Document.findOne({
    where: {
      id,
      teamId: user.teamId,
    },
  });

  if (!document) throw httpErrors.BadRequest();

  // Update document
  document.title = title;
  document.text = text;
  document.lastModifiedById = user.id;
  await document.save();
  await document.createRevision();

  // Update
  const collection = await Atlas.findById(document.atlasId);
  if (collection.type === 'atlas') {
    await collection.updateNavigationTree();
  }

  ctx.body = {
    data: await presentDocument(document, true),
  };
});

router.post('documents.delete', auth(), async (ctx) => {
  const {
    id,
  } = ctx.body;
  ctx.assertPresent(id, 'id is required');

  const user = ctx.state.user;
  const document = await Document.findOne({
    where: {
      id,
      teamId: user.teamId,
    },
  });
  const collection = await Atlas.findById(document.atlasId);

  if (!document) throw httpErrors.BadRequest();

  if (collection.type === 'atlas') {
    // Don't allow deletion of root docs
    if (!document.parentDocumentId) {
      throw httpErrors.BadRequest('Unable to delete atlas\'s root document');
    }

    // Delete all chilren
    try {
      await collection.deleteDocument(document);
      await collection.save();
    } catch (e) {
      throw httpErrors.BadRequest('Error while deleting');
    }
  } else {
    try {
      await document.destroy();
    } catch (e) {
      throw httpErrors.BadRequest('Error while deleting');
    }
  }

  ctx.body = {
    ok: true,
  };
});

export default router;
