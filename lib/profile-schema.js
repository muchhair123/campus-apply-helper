// profile-schema.js — 个人信息库字段定义（单一数据源）
// 供三处共用：options 信息库表单渲染、field-matcher 启发式匹配、resume-parser 解析映射。
//
// 结构：
//   groups: [{ key, label, repeatable, fields: [field] }]
//   field:  { key, label, type, aliases, options? }
//     type:    text | tel | email | date | month | number | textarea | select
//     aliases: 中英文同义词数组，匹配引擎用来识别网页表单字段
//     options: select 类型的候选项
//
// repeatable=true 的分组在 profile 里存为数组（如多段教育经历）；否则存为单对象。

(function (global) {
  const SCHEMA = {
    groups: [
      {
        key: 'basic',
        label: '基本信息',
        repeatable: false,
        fields: [
          { key: 'name', label: '姓名', type: 'text', aliases: ['姓名', '名字', '真实姓名', 'name', 'fullname', 'full name', '申请人姓名'] },
          { key: 'gender', label: '性别', type: 'select', options: ['男', '女'], aliases: ['性别', 'sex', 'gender'] },
          { key: 'birthDate', label: '出生日期', type: 'date', aliases: ['出生日期', '出生年月', '生日', 'birth', 'birthday', 'date of birth', 'dob'] },
          { key: 'ethnicity', label: '民族', type: 'text', aliases: ['民族', 'ethnicity', 'nation'] },
          { key: 'nativePlace', label: '籍贯', type: 'text', aliases: ['籍贯', 'native place', 'hometown', '祖籍'] },
          { key: 'politicalStatus', label: '政治面貌', type: 'select', options: ['群众', '共青团员', '中共党员', '中共预备党员', '民主党派', '其他'], aliases: ['政治面貌', '政治身份', 'political status', 'political'] },
          { key: 'maritalStatus', label: '婚姻状况', type: 'select', options: ['未婚', '已婚', '离异'], aliases: ['婚姻状况', '婚否', 'marital', 'marriage'] },
          { key: 'idCard', label: '身份证号', type: 'text', aliases: ['身份证号', '身份证号码', '证件号码', '身份证', 'id card', 'id number', 'identity'] },
          { key: 'phone', label: '手机号', type: 'tel', aliases: ['手机', '手机号', '手机号码', '联系电话', '移动电话', '电话', '联系方式', 'phone', 'mobile', 'tel', 'cellphone', 'telephone'] },
          { key: 'email', label: '邮箱', type: 'email', aliases: ['邮箱', '电子邮箱', '电子邮件', '常用邮箱', 'email', 'e-mail', 'mail'] },
          { key: 'wechat', label: '微信号', type: 'text', aliases: ['微信', '微信号', 'wechat', 'weixin'] },
          { key: 'currentCity', label: '现居城市', type: 'text', aliases: ['现居住地', '现居地', '所在城市', '居住城市', '当前所在地', 'current city', 'location', 'city', '现所在地'] },
          { key: 'householdCity', label: '户籍所在地', type: 'text', aliases: ['户籍', '户籍所在地', '户口所在地', '户口', 'household', 'hukou'] },
          { key: 'height', label: '身高(cm)', type: 'number', aliases: ['身高', 'height'] },
          { key: 'weight', label: '体重(kg)', type: 'number', aliases: ['体重', 'weight'] },
        ],
      },
      {
        key: 'education',
        label: '教育经历',
        repeatable: true,
        fields: [
          { key: 'school', label: '学校', type: 'text', aliases: ['学校', '毕业院校', '院校', '就读学校', '学校名称', 'school', 'university', 'college', '毕业学校'] },
          { key: 'college', label: '学院/系', type: 'text', aliases: ['学院', '院系', '系别', 'faculty', 'department', 'school of'] },
          { key: 'major', label: '专业', type: 'text', aliases: ['专业', '所学专业', '专业名称', 'major', 'field of study', 'discipline'] },
          { key: 'degree', label: '学历', type: 'select', options: ['大专', '本科', '硕士', '博士', '其他'], aliases: ['学历', '最高学历', '学历层次', 'degree level', 'education level'] },
          { key: 'academicDegree', label: '学位', type: 'select', options: ['学士', '硕士', '博士', '无'], aliases: ['学位', 'degree', 'academic degree'] },
          { key: 'enrollDate', label: '入学年月', type: 'month', aliases: ['入学时间', '入学年月', '起始时间', '入学日期', 'enrollment', 'admission date', 'start date'] },
          { key: 'graduateDate', label: '毕业年月', type: 'month', aliases: ['毕业时间', '毕业年月', '毕业日期', '预计毕业', 'graduation', 'graduate date', 'end date'] },
          { key: 'gpa', label: 'GPA/成绩', type: 'text', aliases: ['gpa', '绩点', '平均分', '成绩', '学分绩', 'grade', 'score', '平均成绩'] },
          { key: 'rank', label: '专业排名', type: 'text', aliases: ['排名', '专业排名', '年级排名', 'rank', 'ranking'] },
          { key: 'studyMode', label: '培养方式', type: 'select', options: ['全日制', '非全日制'], aliases: ['培养方式', '学习方式', '全日制', 'study mode'] },
          { key: 'isUnified', label: '是否统招', type: 'select', options: ['是', '否'], aliases: ['是否统招', '统招', '招生方式'] },
        ],
      },
      {
        key: 'work',
        label: '工作/实习经历',
        repeatable: true,
        fields: [
          { key: 'company', label: '单位名称', type: 'text', aliases: ['单位', '公司', '单位名称', '工作单位', '实习单位', '公司名称', 'company', 'employer', 'organization'] },
          { key: 'title', label: '职位', type: 'text', aliases: ['职位', '岗位', '职务', '担任职务', 'position', 'title', 'role', 'job title'] },
          { key: 'startDate', label: '开始时间', type: 'month', aliases: ['开始时间', '起始时间', '入职时间', 'start date', 'from'] },
          { key: 'endDate', label: '结束时间', type: 'month', aliases: ['结束时间', '离职时间', 'end date', 'to', '至'] },
          { key: 'description', label: '工作描述', type: 'textarea', aliases: ['工作内容', '工作描述', '职责', '工作职责', 'description', 'responsibilities', 'duties'] },
        ],
      },
      {
        key: 'project',
        label: '项目经历',
        repeatable: true,
        fields: [
          { key: 'projectName', label: '项目名称', type: 'text', aliases: ['项目名称', '项目', 'project', 'project name'] },
          { key: 'role', label: '担任角色', type: 'text', aliases: ['角色', '担任角色', '项目角色', 'role'] },
          { key: 'startDate', label: '开始时间', type: 'month', aliases: ['开始时间', '项目起始', 'start date'] },
          { key: 'endDate', label: '结束时间', type: 'month', aliases: ['结束时间', '项目结束', 'end date'] },
          { key: 'description', label: '项目描述', type: 'textarea', aliases: ['项目描述', '项目内容', 'description'] },
        ],
      },
      {
        key: 'skill',
        label: '技能与证书',
        repeatable: false,
        fields: [
          { key: 'cet4', label: '英语四级(CET-4)', type: 'text', aliases: ['四级', 'cet-4', 'cet4', '英语四级'] },
          { key: 'cet6', label: '英语六级(CET-6)', type: 'text', aliases: ['六级', 'cet-6', 'cet6', '英语六级'] },
          { key: 'englishOther', label: '其他外语水平', type: 'text', aliases: ['雅思', '托福', 'ielts', 'toefl', '外语水平', '英语水平', 'english level'] },
          { key: 'computerLevel', label: '计算机等级', type: 'text', aliases: ['计算机等级', '计算机水平', '二级', 'computer level'] },
          { key: 'certificates', label: '专业证书', type: 'textarea', aliases: ['证书', '专业证书', '资格证书', 'certificate', 'certification'] },
          { key: 'skills', label: '技能列表', type: 'textarea', aliases: ['技能', '专业技能', '技能特长', 'skills', '特长'] },
          { key: 'driverLicense', label: '驾照', type: 'text', aliases: ['驾照', '驾驶证', 'driver license', 'driving'] },
        ],
      },
      {
        key: 'award',
        label: '奖项荣誉',
        repeatable: true,
        fields: [
          { key: 'awardName', label: '奖项名称', type: 'text', aliases: ['奖项', '荣誉', '获奖', '奖励名称', 'award', 'honor', 'prize'] },
          { key: 'awardDate', label: '获奖时间', type: 'month', aliases: ['获奖时间', '时间', 'date'] },
          { key: 'awardLevel', label: '级别', type: 'text', aliases: ['级别', '等级', 'level'] },
        ],
      },
      {
        key: 'family',
        label: '家庭成员',
        repeatable: true,
        fields: [
          { key: 'relation', label: '称谓/关系', type: 'text', aliases: ['称谓', '关系', '与本人关系', 'relation', 'relationship'] },
          { key: 'memberName', label: '姓名', type: 'text', aliases: ['姓名', '成员姓名', 'name'] },
          { key: 'memberCompany', label: '工作单位', type: 'text', aliases: ['工作单位', '单位', '工作地点', 'workplace', 'employer'] },
          { key: 'memberTitle', label: '职务', type: 'text', aliases: ['职务', '职位', 'title', 'position'] },
          { key: 'memberPhone', label: '联系电话', type: 'tel', aliases: ['联系电话', '电话', 'phone', 'contact'] },
        ],
      },
      {
        // 平铺父母字段：部分国企网申（如邮储银行）把父母信息拆成独立字段平铺，
        // 不走「可重复条目」。这里用精准全称 aliases 直接命中。
        key: 'familyFlat',
        label: '父母信息（部分国企单独要）',
        repeatable: false,
        fields: [
          { key: 'fatherName', label: '姓名-父亲', type: 'text', aliases: ['姓名-父亲', '父亲姓名', '父亲-姓名', '父亲名字'] },
          { key: 'fatherAge', label: '年龄-父亲', type: 'text', aliases: ['年龄-父亲', '父亲年龄'] },
          { key: 'fatherCompany', label: '工作单位-父亲', type: 'text', aliases: ['工作单位-父亲', '父亲工作单位', '父亲单位'] },
          { key: 'fatherTitle', label: '职位-父亲', type: 'text', aliases: ['职位-父亲', '职务-父亲', '父亲职务', '父亲职位'] },
          { key: 'fatherPhone', label: '联系电话-父亲', type: 'tel', aliases: ['联系电话-父亲', '父亲联系电话', '父亲电话'] },
          { key: 'fatherPolitical', label: '政治面貌-父亲', type: 'text', aliases: ['政治面貌-父亲', '父亲政治面貌'] },
          { key: 'motherName', label: '姓名-母亲', type: 'text', aliases: ['姓名-母亲', '母亲姓名', '母亲-姓名', '母亲名字'] },
          { key: 'motherAge', label: '年龄-母亲', type: 'text', aliases: ['年龄-母亲', '母亲年龄'] },
          { key: 'motherCompany', label: '工作单位-母亲', type: 'text', aliases: ['工作单位-母亲', '母亲工作单位', '母亲单位'] },
          { key: 'motherTitle', label: '职务-母亲', type: 'text', aliases: ['职务-母亲', '职位-母亲', '母亲职务', '母亲职位'] },
          { key: 'motherPhone', label: '联系电话-母亲', type: 'tel', aliases: ['联系电话-母亲', '母亲联系电话', '母亲电话'] },
          { key: 'motherPolitical', label: '政治面貌-母亲', type: 'text', aliases: ['政治面貌-母亲', '母亲政治面貌'] },
        ],
      },
      {
        key: 'intention',
        label: '求职意向',
        repeatable: false,
        fields: [
          { key: 'expectedCity', label: '期望城市', type: 'text', aliases: ['期望城市', '期望工作地', '意向城市', '工作地点', 'expected city', 'preferred location'] },
          { key: 'expectedPosition', label: '期望岗位', type: 'text', aliases: ['期望岗位', '意向岗位', '求职意向', '应聘岗位', 'expected position', 'desired job'] },
          { key: 'expectedSalary', label: '期望薪资', type: 'text', aliases: ['期望薪资', '薪资要求', '期望月薪', 'expected salary', 'salary'] },
          { key: 'availableDate', label: '到岗时间', type: 'text', aliases: ['到岗时间', '可到岗', '入职时间', 'available date', 'start availability'] },
          { key: 'selfIntro', label: '自我评价/简介', type: 'textarea', aliases: ['自我评价', '个人简介', '自我介绍', '个人评价', 'self introduction', 'self evaluation', 'summary', 'about me'] },
        ],
      },
    ],
  };

  // 把一组 groups 扁平化成字段列表（group.key + field.key），供匹配引擎遍历
  function flatten(groups) {
    const out = [];
    for (const g of groups) {
      for (const f of g.fields) {
        out.push({ groupKey: g.key, repeatable: g.repeatable, custom: !!g.custom, ...f });
      }
    }
    return out;
  }

  // 内置字段的扁平列表（默认，无自定义时用）
  SCHEMA.flatFields = flatten(SCHEMA.groups);

  // 合并「内置 + 用户自定义」得到有效 schema。
  // customSchema 结构：{ groups:[{key,label,repeatable,custom:true,fields:[{key,label,type,aliases,custom:true}]}] }
  // 返回 { groups, flatFields }，供渲染/匹配/回写统一使用。
  SCHEMA.buildEffective = function (customSchema) {
    const customGroups = (customSchema && Array.isArray(customSchema.groups)) ? customSchema.groups : [];
    const builtinKeys = new Set(SCHEMA.groups.map((g) => g.key));
    // 规范化一个自定义字段：aliases 兜底为 [label]
    const normField = (f) => ({
      key: f.key, label: f.label, type: f.type || 'text', custom: true,
      aliases: (f.aliases && f.aliases.length) ? f.aliases : [f.label],
    });

    // 内置组：若 customSchema 里有同 key 组，把其 fields 作为"挂载字段"并入（内置固定字段在前）
    const builtin = SCHEMA.groups.map((g) => {
      const mount = customGroups.find((cg) => cg.key === g.key);
      const builtinFieldKeys = new Set(g.fields.map((f) => f.key));
      const mounted = mount && Array.isArray(mount.fields)
        ? mount.fields.filter((f) => !builtinFieldKeys.has(f.key)).map(normField) // 同 key 不覆盖内置
        : [];
      return { ...g, custom: false, fields: g.fields.concat(mounted) };
    });

    // 独立自定义组：key 不等于任何内置模块
    const standalone = customGroups
      .filter((g) => !builtinKeys.has(g.key))
      .map((g) => ({
        key: g.key, label: g.label, repeatable: !!g.repeatable, custom: true,
        fields: (g.fields || []).map(normField),
      }));

    const groups = builtin.concat(standalone);
    return { groups, flatFields: flatten(groups) };
  };

  global.AH_SCHEMA = SCHEMA;
})(typeof window !== 'undefined' ? window : self);
